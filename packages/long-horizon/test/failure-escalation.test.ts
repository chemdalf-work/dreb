import { describe, expect, it } from "vitest";
import { getWorkspaceIdentity } from "../src/policy.js";
import { LongHorizonSupervisor } from "../src/supervisor.js";
import { commandEvidence, FakeSessionHost, PLAN, promptResult, report, testConfig } from "./helpers.js";

const failure =
	'"failure":{"operation":"test","command":"npm test","exitCode":1,"diagnostic":"same failure at /tmp/work/file.ts"},';
const advice =
	'<dreb-advice>{"schemaVersion":1,"workUnitId":"unit","failureSignature":"SIGNATURE","strategyId":"strategy-b","advice":"change approach"}</dreb-advice>';

describe("failure escalation", () => {
	it("launches exactly one fresh advisor on the fourth equivalent failure and applies its advice", async () => {
		const base = testConfig();
		const config = { ...base, limits: { ...base.limits, maxEscalations: 1 } };
		const failureEvidence = commandEvidence("npm test", "workspace", 1);
		const failed = promptResult(
			report("failed", failure).replace('"evidenceIds":[]', `"evidenceIds":["${failureEvidence.id}"]`),
			{ commandEvidence: [failureEvidence] },
		);
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [failed, failed, failed, failed, promptResult(report("complete"))],
			advisor: [promptResult(advice)],
		});
		const originalPrompt = sessions.create.bind(sessions);
		// Advisor must echo the deterministic signature supplied in its prompt.
		sessions.create = async (...args) => {
			const hosted = await originalPrompt(...args);
			if (args[0] !== "advisor") return hosted;
			return {
				...hosted,
				prompt: async (text) =>
					hosted.prompt(text).then((result) => ({
						...result,
						text: result.text.replace("SIGNATURE", text.match(/"signature":"([a-f0-9]+)"/)?.[1] ?? "missing"),
					})),
			};
		};
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const status = await LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner }).run();
		expect(status.phase).toBe("completed");
		expect(status.escalations).toBe(1);
		expect(sessions.created.filter((session) => session.role === "advisor")).toHaveLength(1);
		expect(sessions.prompts.filter((item) => item.sessionId.startsWith("executor-")).at(-1)?.text).toContain(
			"Advisor guidance",
		);
	});

	it("isolates and resets streaks while preventing duplicate escalation after restart", () => {
		const config = testConfig();
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: new FakeSessionHost({}) });
		const store = supervisor.store;
		store.append({ type: "failure_recorded", workUnitId: "a", strategyId: "s", signature: "one" });
		store.append({ type: "failure_recorded", workUnitId: "b", strategyId: "s", signature: "two" });
		expect(store.replay().failureStreak).toMatchObject({ workUnitId: "b", signature: "two", count: 1 });
		store.append({ type: "failure_reset", workUnitId: "b", reason: "verification" });
		expect(store.replay().failureStreak).toBeUndefined();
		for (let attempt = 0; attempt < 4; attempt++) {
			store.append({ type: "failure_recorded", workUnitId: "b", strategyId: "s", signature: "two" });
		}
		store.append({
			type: "escalation_completed",
			workUnitId: "b",
			signature: "two",
			adviceArtifact: "advice.json",
		});
		expect(() =>
			store.append({
				type: "escalation_completed",
				workUnitId: "b",
				signature: "two",
				adviceArtifact: "advice.json",
			}),
		).toThrow(/un-escalated/);
	});
});
