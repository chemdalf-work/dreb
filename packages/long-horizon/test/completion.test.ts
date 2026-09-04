import { describe, expect, it } from "vitest";
import { getWorkspaceIdentity } from "../src/policy.js";
import { LongHorizonSupervisor } from "../src/supervisor.js";
import { commandEvidence, FakeSessionHost, PLAN, promptResult, report, testConfig } from "./helpers.js";

describe("completion gating", () => {
	it("rejects a model completion claim when a fixed acceptance command fails", async () => {
		const config = testConfig();
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("complete"))],
		});
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd), 1);
		const status = await LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner }).run();
		expect(status.phase).toBe("blocked");
		expect(status.blockedReason).toMatch(/completion candidate rejected/);
	});

	it("gives an abort arriving during acceptance precedence over completion", async () => {
		const config = testConfig();
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("complete"))],
		});
		let supervisor: LongHorizonSupervisor;
		const commandRunner = async (command: string, cwd: string) => {
			supervisor.store.requestControl("abort", "stop during acceptance");
			return commandEvidence(command, await getWorkspaceIdentity(cwd));
		};
		supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });
		const status = await supervisor.run();
		expect(status.phase).toBe("aborted");
	});

	it("rejects a verifier response whose final-assessment identity is inconsistent", async () => {
		const config = testConfig({ verifier: { provider: "test", modelId: "sol", thinkingLevel: "max" } });
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("complete"))],
			verifier: [
				promptResult(
					'<dreb-advice>{"schemaVersion":1,"workUnitId":"unit","failureSignature":"none","strategyId":"accept","advice":"done"}</dreb-advice>',
				),
			],
		});
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const status = await LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner }).run();
		expect(status.phase).toBe("blocked");
	});

	it("requires an optional fresh verifier to accept", async () => {
		const config = testConfig({ verifier: { provider: "test", modelId: "sol", thinkingLevel: "max" } });
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("complete"))],
			verifier: [
				promptResult(
					'<dreb-advice>{"schemaVersion":1,"workUnitId":"final","failureSignature":"none","strategyId":"reject","advice":"missing behavior"}</dreb-advice>',
				),
			],
		});
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const status = await LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner }).run();
		expect(status.phase).toBe("blocked");
		expect(sessions.created.at(-1)?.role).toBe("verifier");
	});
});
