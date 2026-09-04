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
		if (planEvent?.event.type !== "effect_completed" || !planEvent.event.artifact)
			throw new Error("missing plan artifact");
		expect(supervisor.store.readArtifact<Record<string, unknown>>(planEvent.event.artifact).value).toBeUndefined();
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
