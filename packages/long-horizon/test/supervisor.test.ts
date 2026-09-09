import { describe, expect, it } from "vitest";
import { getWorkspaceIdentity } from "../src/policy.js";
import { LongHorizonSupervisor } from "../src/supervisor.js";
import { commandEvidence, FakeSessionHost, PLAN, promptResult, report, testConfig } from "./helpers.js";

describe("LongHorizonSupervisor", () => {
	it("runs Sol planning then Terra execution and completes at the configured final round", async () => {
		const base = testConfig();
		const config = { ...base, limits: { ...base.limits, maxRounds: 1 } };
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("complete"))],
		});
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });
		const status = await supervisor.run();
		expect(status.phase).toBe("completed");
		expect(sessions.created.map((session) => session.role)).toEqual(["planner", "executor"]);
		expect(status.rounds).toBe(1);
		const records = supervisor.store.readRecords();
		const committedRound = records.find((record) => record.event.type === "round_completed");
		expect(committedRound?.event).toMatchObject({ type: "round_completed", round: 1 });
		expect(records.some((record) => record.event.type === "effect_completed" && record.event.kind === "round")).toBe(
			false,
		);
	});

	it("fails before planning when the workspace identity is unavailable", async () => {
		const config = testConfig();
		const nonGitCwd = `${config.cwd}-not-git`;
		const invalid = { ...config, cwd: nonGitCwd };
		const sessions = new FakeSessionHost({});
		const status = await LongHorizonSupervisor.create(invalid, { sessionHost: sessions }).run();
		expect(status.phase).toBe("failed");
		expect(status.blockedReason).toMatch(/workspace validation failed/);
		expect(sessions.created).toHaveLength(0);
	});

	it("enforces token limits immediately after planning before executor dispatch", async () => {
		const base = testConfig();
		const config = { ...base, limits: { ...base.limits, maxTotalTokens: 50 } };
		const sessions = new FakeSessionHost({ planner: [promptResult(PLAN, { tokens: 50 })] });
		const status = await LongHorizonSupervisor.create(config, { sessionHost: sessions }).run();
		expect(status.phase).toBe("failed");
		expect(sessions.created.map((session) => session.role)).toEqual(["planner"]);
	});

	it("honors a persisted pause before creating a planner session", async () => {
		const config = testConfig();
		const sessions = new FakeSessionHost({});
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions });
		supervisor.requestPause("hold before start");
		const status = await supervisor.run();
		expect(status.phase).toBe("paused");
		expect(sessions.created).toHaveLength(0);
	});

	it("does not dispatch a model prompt when abort persists during session creation", async () => {
		const config = testConfig();
		const sessions = new FakeSessionHost({ planner: [promptResult(PLAN)] });
		let supervisor: LongHorizonSupervisor;
		const create = sessions.create.bind(sessions);
		sessions.create = async (...args) => {
			const hosted = await create(...args);
			supervisor.store.requestControl("abort", "stop before prompt dispatch");
			return hosted;
		};
		supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions });

		const status = await supervisor.run();

		expect(status.phase).toBe("aborted");
		expect(sessions.prompts).toHaveLength(0);
		expect(status.pendingEffect).toBeUndefined();
	});

	it("never promotes a rejected plan artifact on resume", async () => {
		const config = testConfig();
		const badPlan = PLAN.replace("finish the test objective", "different objective");
		const sessions = new FakeSessionHost({ planner: [promptResult(badPlan)] });
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions });
		const blocked = await supervisor.run();
		expect(blocked.phase).toBe("blocked");
		const planEvent = supervisor.store
			.readRecords()
			.find((record) => record.event.type === "effect_completed" && record.event.kind === "plan");
		if (planEvent?.event.type !== "effect_completed" || !planEvent.event.artifact || !planEvent.event.artifactDigest)
			throw new Error("missing plan artifact");
		expect(
			supervisor.store.readArtifact<Record<string, unknown>>(
				planEvent.event.artifact,
				planEvent.event.artifactDigest,
			).value,
		).toBeUndefined();
		expect(sessions.created.some((session) => session.role === "executor")).toBe(false);
	});

	it("durably blocks when ask_user is observed", async () => {
		const config = testConfig();
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("progress"), { askUserObserved: true })],
		});
		const status = await LongHorizonSupervisor.create(config, { sessionHost: sessions }).run();
		expect(status.phase).toBe("blocked");
		expect(status.blockedReason).toMatch(/human input/);
	});

	it("durably blocks a round with an uncertain command outcome before accepting its report", async () => {
		const config = testConfig();
		const now = new Date().toISOString();
		const uncertain = {
			outcome: "uncertain" as const,
			id: "uncertain-command",
			command: "npm test",
			exitCode: 0,
			stdout: "side effect completed",
			stderr: "",
			startedAt: now,
			completedAt: now,
			reconciliationError: "workspace identity failed",
		};
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("progress"), { commandEvidence: [uncertain] })],
		});
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions });

		const status = await supervisor.run();

		expect(status.phase).toBe("blocked");
		expect(status.rounds).toBe(0);
		expect(status.pendingEffect?.kind).toBe("round");
		expect(status.blockedReason).toMatch(/command outcome requires reconciliation/);
		expect(
			supervisor.store
				.readRecords()
				.some(
					(record) =>
						record.event.type === "command_outcome_uncertain" && record.event.evidence.id === "uncertain-command",
				),
		).toBe(true);
		expect(sessions.prompts.filter((prompt) => prompt.sessionId.startsWith("executor-"))).toHaveLength(1);
	});

	it("durably blocks a policy-denied command before accepting its round report", async () => {
		const config = testConfig();
		const now = new Date().toISOString();
		const denied = {
			outcome: "denied" as const,
			id: "denied-command",
			command: "git push origin main",
			exitCode: null,
			stdout: "",
			stderr: "",
			startedAt: now,
			completedAt: now,
			reason: "remote-state mutation denied",
		};
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("progress"), { commandEvidence: [denied] })],
		});
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions });

		const status = await supervisor.run();

		expect(status.phase).toBe("blocked");
		expect(status.rounds).toBe(0);
		expect(status.pendingEffect?.kind).toBe("round");
		expect(status.blockedReason).toMatch(/command authorization denied.*remote-state mutation denied/);
		expect(supervisor.store.readRecords().some((record) => record.event.type === "round_completed")).toBe(false);
		expect(sessions.prompts.filter((prompt) => prompt.sessionId.startsWith("executor-"))).toHaveLength(1);

		const reopened = LongHorizonSupervisor.open(supervisor.store.runDir, { sessionHost: sessions });
		const reopenedStatus = await reopened.run();
		expect(reopenedStatus.phase).toBe("blocked");
		expect(reopenedStatus.pendingEffect?.kind).toBe("round");
		expect(sessions.prompts.filter((prompt) => prompt.sessionId.startsWith("executor-"))).toHaveLength(1);
	});

	it("fails closed instead of redispatching an interrupted effect", async () => {
		const config = testConfig();
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: new FakeSessionHost({}) });
		supervisor.store.append({ type: "effect_intent", effectId: "lost", kind: "plan" });
		const status = await supervisor.run();
		expect(status.phase).toBe("blocked");
		expect(status.pendingEffect?.effectId).toBe("lost");
		supervisor.store.acknowledgePendingEffect("inspected linked session and workspace");
		expect(supervisor.store.replay().pendingEffect).toBeUndefined();
	});
});
