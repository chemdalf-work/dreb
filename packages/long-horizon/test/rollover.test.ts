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
		const planArtifact = store.writeArtifact("plan", planId, { value: parseSolPlan(PLAN) });
		store.append({ type: "effect_completed", effectId: planId, kind: "plan", artifact: planArtifact });
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
		store.append({ type: "effect_completed", effectId: roundId, kind: "round", artifact: roundArtifact });
		store.append({ type: "context_observed", sessionId: "old", tokens: 301_000, contextWindow: 400_000 });
		store.append({ type: "round_completed", round: 1, report: prior, verificationSucceeded: false });

		const sessions = new FakeSessionHost({ executor: [promptResult(report("complete"))] });
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const status = await new LongHorizonSupervisor(store, { sessionHost: sessions, commandRunner }).run();
		expect(status.phase).toBe("completed");
		expect(sessions.created[0].parentFile).toBe(oldFile);
		expect(sessions.prompts[0].text).toContain("validated durable handoff");
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
