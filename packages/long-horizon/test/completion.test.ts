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

	it("retries failed acceptance only after an explicit blocked-run resume", async () => {
		const config = testConfig();
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("complete"))],
		});
		let calls = 0;
		const commandRunner = async (command: string, cwd: string) => {
			calls++;
			return commandEvidence(command, await getWorkspaceIdentity(cwd), calls === 1 ? 1 : 0);
		};
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });

		const blocked = await supervisor.run();
		expect(blocked.phase).toBe("blocked");
		expect(calls).toBe(1);

		supervisor.requestResume("retry rejected acceptance");
		const resumed = LongHorizonSupervisor.open(supervisor.store.runDir, { sessionHost: sessions, commandRunner });
		const completed = await resumed.run();
		expect(completed.phase).toBe("completed");
		expect(calls).toBe(2);
	});

	it("retries only the failed acceptance command after an explicit resume", async () => {
		const config = testConfig({ acceptanceCommands: ["check-one", "check-two"] });
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("complete"))],
		});
		const calls: string[] = [];
		const commandRunner = async (command: string, cwd: string) => {
			calls.push(command);
			const secondAttempt = command === "check-two" && calls.filter((item) => item === command).length > 1;
			return commandEvidence(
				command,
				await getWorkspaceIdentity(cwd),
				command === "check-two" && !secondAttempt ? 1 : 0,
			);
		};
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });

		const blocked = await supervisor.run();
		expect(blocked.phase).toBe("blocked");
		expect(calls).toEqual(["check-one", "check-two"]);

		supervisor.requestResume("retry failed acceptance command");
		const resumed = LongHorizonSupervisor.open(supervisor.store.runDir, { sessionHost: sessions, commandRunner });
		const completed = await resumed.run();
		expect(completed.phase).toBe("completed");
		expect(calls).toEqual(["check-one", "check-two", "check-two"]);
	});

	it("retries a rejected verifier without repeating passed acceptance commands", async () => {
		const config = testConfig({ verifier: { provider: "test", modelId: "sol", thinkingLevel: "max" } });
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("complete"))],
			verifier: [
				promptResult(
					'<dreb-advice>{"schemaVersion":1,"workUnitId":"final","failureSignature":"none","strategyId":"reject","advice":"not yet"}</dreb-advice>',
				),
				promptResult(
					'<dreb-advice>{"schemaVersion":1,"workUnitId":"final","failureSignature":"none","strategyId":"accept","advice":"verified"}</dreb-advice>',
				),
			],
		});
		let commandCalls = 0;
		const commandRunner = async (command: string, cwd: string) => {
			commandCalls++;
			return commandEvidence(command, await getWorkspaceIdentity(cwd));
		};
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });

		const blocked = await supervisor.run();
		expect(blocked.phase).toBe("blocked");
		expect(commandCalls).toBe(1);

		supervisor.requestResume("retry rejected verifier");
		const resumed = LongHorizonSupervisor.open(supervisor.store.runDir, { sessionHost: sessions, commandRunner });
		const completed = await resumed.run();
		expect(completed.phase).toBe("completed");
		expect(commandCalls).toBe(1);
		expect(sessions.prompts.filter((prompt) => prompt.sessionId.startsWith("verifier-"))).toHaveLength(2);
	});

	it("does not repeat completed acceptance commands after pause and resume", async () => {
		const config = testConfig();
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [promptResult(report("complete"))],
		});
		let supervisor!: LongHorizonSupervisor;
		let calls = 0;
		const commandRunner = async (command: string, cwd: string) => {
			calls++;
			if (calls === 1) supervisor.requestPause("pause after acceptance command");
			return commandEvidence(command, await getWorkspaceIdentity(cwd));
		};
		supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });

		const paused = await supervisor.run();
		expect(paused.phase).toBe("paused");
		expect(calls).toBe(1);

		supervisor.requestResume("continue completion");
		const resumed = LongHorizonSupervisor.open(supervisor.store.runDir, { sessionHost: sessions, commandRunner });
		const completed = await resumed.run();
		expect(completed.phase).toBe("completed");
		expect(calls).toBe(1);
	});

	it("reuses a completed final-verification checkpoint after pause and resume", async () => {
		const config = testConfig({ verifier: { provider: "test", modelId: "sol", thinkingLevel: "max" } });
		let supervisor!: LongHorizonSupervisor;
		let verifierPrompts = 0;
		const sessions = new FakeSessionHost(
			{
				planner: [promptResult(PLAN)],
				executor: [promptResult(report("complete"))],
				verifier: [
					promptResult(
						'<dreb-advice>{"schemaVersion":1,"workUnitId":"final","failureSignature":"none","strategyId":"accept","advice":"verified"}</dreb-advice>',
					),
				],
			},
			(role) => {
				if (role === "verifier") {
					verifierPrompts++;
					if (verifierPrompts === 1) supervisor.requestPause("pause after final verification");
				}
			},
		);
		let commandCalls = 0;
		const commandRunner = async (command: string, cwd: string) => {
			commandCalls++;
			return commandEvidence(command, await getWorkspaceIdentity(cwd));
		};
		supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });

		const paused = await supervisor.run();
		expect(paused.phase).toBe("paused");
		expect(commandCalls).toBe(1);
		expect(verifierPrompts).toBe(1);

		supervisor.requestResume("finish after verification");
		const resumed = LongHorizonSupervisor.open(supervisor.store.runDir, { sessionHost: sessions, commandRunner });
		const completed = await resumed.run();
		expect(completed.phase).toBe("completed");
		expect(commandCalls).toBe(1);
		expect(verifierPrompts).toBe(1);
	});
});
