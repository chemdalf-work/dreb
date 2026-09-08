import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getWorkspaceIdentity } from "../src/policy.js";
import { parseSolPlan, parseTerraReport } from "../src/reports.js";
import { RunStore } from "../src/run-store.js";
import { LongHorizonSupervisor } from "../src/supervisor.js";
import { commandEvidence, FakeSessionHost, PLAN, promptResult, report, testConfig } from "./helpers.js";

describe("safe-edge rollover", () => {
	it("allows the configured final handoff to continue in the fresh session", async () => {
		const base = testConfig();
		const config = {
			...base,
			rollover: { softTokens: 250_000, strongTokens: 300_000 },
			limits: { ...base.limits, maxHandoffs: 1 },
		};
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [
				promptResult(report("progress"), { context: { tokens: 301_000, contextWindow: 400_000 } }),
				promptResult(report("complete"), { context: { tokens: 1_000, contextWindow: 400_000 } }),
			],
		});
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const status = await LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner }).run();
		const executors = sessions.created.filter((session) => session.role === "executor");
		expect(status.phase).toBe("completed");
		expect(executors).toHaveLength(2);
		expect(executors[1].parentFile).toBe(executors[0].file);
		expect(sessions.prompts.filter((item) => item.sessionId === executors[0].id)).toHaveLength(1);
		expect(sessions.prompts.find((item) => item.sessionId === executors[1].id)?.text).toContain(
			"validated durable handoff",
		);
	});

	it("rolls over before dispatch when recovery finds persisted strong-threshold context", async () => {
		const config = testConfig();
		const store = RunStore.create(config);
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		const planId = "plan-recovery";
		store.append({ type: "effect_intent", effectId: planId, kind: "plan" });
		const planArtifact = store.writeArtifact("plan", planId, {
			value: parseSolPlan(PLAN),
			result: promptResult(PLAN),
		});
		store.append({
			type: "effect_completed",
			effectId: planId,
			kind: "plan",
			artifact: planArtifact,
			artifactDigest: store.artifactDigest(planArtifact),
		});
		store.append({ type: "phase_changed", from: "planning", to: "executing", reason: "planned" });
		const oldFile = `${store.sessionsDir}/old.jsonl`;
		writeFileSync(oldFile, "session evidence");
		store.append({
			type: "session_registered",
			session: {
				id: "old",
				role: "executor",
				file: oldFile,
				provider: "test",
				modelId: "terra",
				thinkingLevel: "high",
				createdAt: new Date().toISOString(),
			},
		});
		const prior = parseTerraReport(report("progress"), []);
		const roundId = "round-recovery";
		store.append({ type: "effect_intent", effectId: roundId, kind: "round", sessionId: "old" });
		const roundArtifact = store.writeArtifact("round", roundId, { value: prior });
		store.append({ type: "context_observed", sessionId: "old", tokens: 301_000, contextWindow: 400_000 });
		store.append({
			type: "round_completed",
			effectId: roundId,
			artifact: roundArtifact,
			artifactDigest: store.artifactDigest(roundArtifact),
			round: 1,
			report: prior,
			verificationSucceeded: false,
		});

		const sessions = new FakeSessionHost({ executor: [promptResult(report("complete"))] });
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const status = await new LongHorizonSupervisor(store, { sessionHost: sessions, commandRunner }).run();
		expect(status.phase).toBe("completed");
		expect(sessions.created[0].parentFile).toBe(oldFile);
		expect(sessions.prompts[0].text).toContain("validated durable handoff");
	});

	it("creates the next child after a crash during a later-generation handoff", async () => {
		const config = testConfig();
		const store = RunStore.create(config);
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		store.append({ type: "effect_intent", effectId: "plan-later", kind: "plan" });
		const planArtifact = store.writeArtifact("plan", "plan-later", {
			value: parseSolPlan(PLAN),
			result: promptResult(PLAN),
		});
		store.append({
			type: "effect_completed",
			effectId: "plan-later",
			kind: "plan",
			artifact: planArtifact,
			artifactDigest: store.artifactDigest(planArtifact),
		});
		store.append({ type: "phase_changed", from: "planning", to: "executing", reason: "planned" });
		const firstFile = `${store.sessionsDir}/executor-a.jsonl`;
		const secondFile = `${store.sessionsDir}/executor-b.jsonl`;
		writeFileSync(firstFile, "first generation\n");
		writeFileSync(secondFile, "second generation\n");
		store.append({
			type: "session_registered",
			session: {
				id: "executor-a",
				role: "executor",
				file: firstFile,
				provider: "test",
				modelId: "terra",
				thinkingLevel: "high",
				createdAt: new Date().toISOString(),
			},
		});
		store.append({
			type: "session_registered",
			session: {
				id: "executor-b",
				role: "executor",
				file: secondFile,
				parentFile: firstFile,
				provider: "test",
				modelId: "terra",
				thinkingLevel: "high",
				createdAt: new Date().toISOString(),
			},
		});
		store.append({ type: "phase_changed", from: "executing", to: "handoff", reason: "safe-edge rollover" });
		store.append({ type: "effect_intent", effectId: "handoff-b", kind: "handoff", sessionId: "executor-b" });
		const handoffArtifact = store.writeArtifact("handoff", "handoff-b", {
			schemaVersion: 1,
			fromSessionId: "executor-b",
			workUnitId: "unit",
			strategyId: "strategy-a",
			summary: "second generation reached the safe edge",
			nextAction: "continue in a third generation",
			evidenceIds: [],
			createdAt: new Date().toISOString(),
		});
		store.append({
			type: "effect_completed",
			effectId: "handoff-b",
			kind: "handoff",
			artifact: handoffArtifact,
			artifactDigest: store.artifactDigest(handoffArtifact),
		});

		const sessions = new FakeSessionHost({ executor: [promptResult(report("complete"))] });
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const status = await new LongHorizonSupervisor(RunStore.open(store.runDir), {
			sessionHost: sessions,
			commandRunner,
		}).run();
		expect(status.phase).toBe("completed");
		expect(status.handoffs).toBe(2);
		expect(sessions.created).toHaveLength(1);
		expect(sessions.created[0].parentFile).toBe(secondFile);
		expect(sessions.prompts).toEqual([
			expect.objectContaining({
				sessionId: sessions.created[0].id,
				text: expect.stringContaining("validated durable handoff"),
			}),
		]);
	});

	it("rejects an invalid handoff artifact before creating its child session", () => {
		const config = testConfig();
		const store = RunStore.create(config);
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		store.append({ type: "effect_intent", effectId: "plan-strict", kind: "plan" });
		const planArtifact = store.writeArtifact("plan", "plan-strict", {
			value: parseSolPlan(PLAN),
			result: promptResult(PLAN),
		});
		store.append({
			type: "effect_completed",
			effectId: "plan-strict",
			kind: "plan",
			artifact: planArtifact,
			artifactDigest: store.artifactDigest(planArtifact),
		});
		store.append({ type: "phase_changed", from: "planning", to: "executing", reason: "planned" });
		const parentFile = `${store.sessionsDir}/parent.jsonl`;
		writeFileSync(parentFile, "parent\n");
		store.append({
			type: "session_registered",
			session: {
				id: "parent",
				role: "executor",
				file: parentFile,
				provider: "test",
				modelId: "terra",
				thinkingLevel: "high",
				createdAt: new Date().toISOString(),
			},
		});
		store.append({ type: "phase_changed", from: "executing", to: "handoff", reason: "recover" });
		store.append({ type: "effect_intent", effectId: "handoff-strict", kind: "handoff", sessionId: "parent" });
		const handoffArtifact = store.writeArtifact("handoff", "handoff-strict", {
			schemaVersion: 1,
			fromSessionId: 42,
			workUnitId: "unit",
			strategyId: "strategy-a",
			summary: "checkpoint",
			nextAction: "continue",
			evidenceIds: [],
			createdAt: new Date().toISOString(),
		});
		expect(() =>
			store.append({
				type: "effect_completed",
				effectId: "handoff-strict",
				kind: "handoff",
				artifact: handoffArtifact,
				artifactDigest: store.artifactDigest(handoffArtifact),
			}),
		).toThrow(/fromSessionId/);
		expect(store.replay().pendingEffect).toMatchObject({ effectId: "handoff-strict", kind: "handoff" });
	});

	it("uses the soft band for wrap-up without interrupting or replacing the current session", async () => {
		const config = testConfig();
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [
				promptResult(report("progress"), { context: { tokens: 280_000, contextWindow: 400_000 } }),
				promptResult(report("complete"), { context: { tokens: 290_000, contextWindow: 400_000 } }),
			],
		});
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const status = await LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner }).run();
		const executors = sessions.created.filter((session) => session.role === "executor");
		expect(status.rounds).toBe(2);
		expect(status.phase).toBe("completed");
		expect(executors).toHaveLength(1);
		expect(sessions.aborted).toHaveLength(0);
		expect(sessions.prompts.at(-1)?.text).toContain("wrap-up band");
	});
});
