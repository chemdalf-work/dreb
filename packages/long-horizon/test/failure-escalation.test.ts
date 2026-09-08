import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkspaceIdentity } from "../src/policy.js";
import { RunStore } from "../src/run-store.js";
import { LongHorizonSupervisor } from "../src/supervisor.js";
import { commandEvidence, FakeSessionHost, PLAN, promptResult, report, testConfig } from "./helpers.js";

const failure =
	'"failure":{"operation":"test","command":"npm test","exitCode":1,"diagnostic":"same failure at /tmp/work/file.ts"},';
const advice =
	'<dreb-advice>{"schemaVersion":1,"workUnitId":"unit","failureSignature":"SIGNATURE","strategyId":"strategy-b","advice":"change approach"}</dreb-advice>';

function echoAdvisorSignature(sessions: FakeSessionHost): void {
	const create = sessions.create.bind(sessions);
	sessions.create = async (...args) => {
		const hosted = await create(...args);
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
}

describe("failure escalation", () => {
	it("launches exactly one fresh advisor on the fourth equivalent failure and applies its advice", async () => {
		const base = testConfig();
		const config = { ...base, limits: { ...base.limits, maxEscalations: 1 } };
		writeFileSync(join(config.cwd, "file.txt"), "advisor workspace context\n".repeat(4_000));
		const failureEvidence = commandEvidence("npm test", "workspace", 1);
		failureEvidence.stdout = "exact failing stdout";
		failureEvidence.stderr = "exact failing stderr";
		const failed = promptResult(
			report("verification-failed", failure).replace('"evidenceIds":[]', `"evidenceIds":["${failureEvidence.id}"]`),
			{ commandEvidence: [failureEvidence] },
		);
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [failed, failed, failed, failed, promptResult(report("complete"))],
			advisor: [promptResult(advice)],
		});
		// Advisor must echo the deterministic signature supplied in its prompt.
		echoAdvisorSignature(sessions);
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });
		const status = await supervisor.run();
		expect(status.phase).toBe("completed");
		expect(status.escalations).toBe(1);
		expect(sessions.created.filter((session) => session.role === "advisor")).toHaveLength(1);
		const advisorPrompt = sessions.prompts.find((item) => item.sessionId.startsWith("advisor-"))?.text;
		expect(advisorPrompt).toContain("Validated plan excerpt");
		expect(advisorPrompt).toContain('"acceptanceCriteria":["tests pass"]');
		expect(advisorPrompt).toContain("Workspace state and diff");
		expect(advisorPrompt).toContain("advisor workspace context");
		expect(advisorPrompt).toContain("[truncated at 32768 bytes]");
		expect(advisorPrompt).toContain('"workspaceIdentity":"workspace"');
		expect(advisorPrompt).toContain(`"id":"${failureEvidence.id}"`);
		expect(advisorPrompt).toContain('"stdout":"exact failing stdout"');
		expect(advisorPrompt).toContain('"stderr":"exact failing stderr"');
		expect(advisorPrompt!.length).toBeLessThan(100_000);
		const failedRound = supervisor.store
			.readRecords()
			.find((record) => record.event.type === "round_completed" && record.event.failureEvidence);
		expect(failedRound?.event).toMatchObject({
			type: "round_completed",
			failureEvidence: { source: "command", evidence: failureEvidence },
		});
		expect(sessions.prompts.filter((item) => item.sessionId.startsWith("executor-")).at(-1)?.text).toContain(
			"Advisor guidance",
		);
	});

	it("does not reset equivalent failures for a successful non-verification command", async () => {
		const base = testConfig();
		const config = { ...base, limits: { ...base.limits, maxEscalations: 1 } };
		const failureEvidence = commandEvidence("npm test", "workspace", 1);
		const statusEvidence = commandEvidence("git status --short", "workspace");
		const failed = promptResult(
			report("verification-failed", failure).replace(
				'"evidenceIds":[]',
				`"evidenceIds":["${failureEvidence.id}","${statusEvidence.id}"]`,
			),
			{ commandEvidence: [failureEvidence, statusEvidence] },
		);
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [failed, failed, failed, failed, promptResult(report("complete"))],
			advisor: [promptResult(advice)],
		});
		echoAdvisorSignature(sessions);
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));

		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });
		const status = await supervisor.run();

		expect(status.phase).toBe("completed");
		expect(status.escalations).toBe(1);
		expect(sessions.created.filter((session) => session.role === "advisor")).toHaveLength(1);
		const rounds = supervisor.store
			.readRecords()
			.filter((record) => record.event.type === "round_completed")
			.map((record) => (record.event.type === "round_completed" ? record.event : undefined));
		expect(rounds.slice(0, 4).every((event) => event?.verificationSucceeded === false)).toBe(true);
	});

	it("resets a failure streak after referenced acceptance-command verification succeeds", async () => {
		const config = testConfig();
		const failureEvidence = commandEvidence("npm test", "workspace", 1);
		const verificationEvidence = commandEvidence("npm test", "workspace");
		const failed = promptResult(
			report("verification-failed", failure).replace('"evidenceIds":[]', `"evidenceIds":["${failureEvidence.id}"]`),
			{ commandEvidence: [failureEvidence] },
		);
		const verified = promptResult(
			report("progress").replace('"evidenceIds":[]', `"evidenceIds":["${verificationEvidence.id}"]`),
			{ commandEvidence: [verificationEvidence] },
		);
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [failed, verified, promptResult(report("complete"))],
		});
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));

		const supervisor = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });
		const status = await supervisor.run();

		expect(status.phase).toBe("completed");
		expect(status.failureStreak).toBeUndefined();
		const verifiedRound = supervisor.store
			.readRecords()
			.find((record) => record.event.type === "round_completed" && record.event.round === 2);
		expect(verifiedRound?.event).toMatchObject({ type: "round_completed", verificationSucceeded: true });
	});

	it("does not promote rejected same-strategy advice after restart", async () => {
		const base = testConfig();
		const config = { ...base, limits: { ...base.limits, maxEscalations: 1 } };
		const failureEvidence = commandEvidence("npm test", "workspace", 1);
		const failed = promptResult(
			report("verification-failed", failure).replace('"evidenceIds":[]', `"evidenceIds":["${failureEvidence.id}"]`),
			{ commandEvidence: [failureEvidence] },
		);
		const rejectedAdvice = advice.replace('"strategyId":"strategy-b"', '"strategyId":"strategy-a"');
		const sessions = new FakeSessionHost({
			planner: [promptResult(PLAN)],
			executor: [failed, failed, failed, failed, promptResult(report("complete"))],
			advisor: [promptResult(rejectedAdvice), promptResult(advice)],
		});
		echoAdvisorSignature(sessions);
		const commandRunner = async (command: string, cwd: string) =>
			commandEvidence(command, await getWorkspaceIdentity(cwd));
		const first = LongHorizonSupervisor.create(config, { sessionHost: sessions, commandRunner });

		const blocked = await first.run();
		expect(blocked.phase).toBe("blocked");
		expect(blocked.escalations).toBe(0);
		expect(blocked.blockedReason).toMatch(/different strategy ID/);

		first.requestResume("retry rejected advice");
		const restarted = new LongHorizonSupervisor(RunStore.open(first.store.runDir), {
			sessionHost: sessions,
			commandRunner,
		});
		const completed = await restarted.run();
		expect(completed.phase).toBe("completed");
		expect(completed.escalations).toBe(1);
		expect(sessions.created.filter((session) => session.role === "advisor")).toHaveLength(2);
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
		const adviceArtifact = store.writeArtifact("advice", "manual", { advice: "change approach" });
		const adviceArtifactDigest = store.artifactDigest(adviceArtifact);
		store.append({
			type: "escalation_completed",
			workUnitId: "b",
			signature: "two",
			adviceArtifact,
			adviceArtifactDigest,
		});
		expect(() =>
			store.append({
				type: "escalation_completed",
				workUnitId: "b",
				signature: "two",
				adviceArtifact,
				adviceArtifactDigest,
			}),
		).toThrow(/un-escalated/);
	});
});
