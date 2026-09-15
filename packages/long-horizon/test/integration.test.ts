import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSolPlan, parseTerraReport } from "../src/reports.js";
import { RunStore } from "../src/run-store.js";
import { LongHorizonSupervisor } from "../src/supervisor.js";
import { FakeSessionHost, PLAN, promptResult, report, testConfig } from "./helpers.js";

describe("filesystem-backed integration", () => {
	it("replays controls and session lineage from journal after restart", async () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		store.requestControl("pause", "maintenance");
		store.append({ type: "phase_changed", from: "planning", to: "paused", reason: "operator requested pause" });
		const reopened = RunStore.open(store.runDir);
		expect(reopened.replay().phase).toBe("paused");
		expect(readFileSync(reopened.journalPath, "utf8").trim().split("\n").length).toBe(4);
		const status = await new LongHorizonSupervisor(reopened, { sessionHost: new FakeSessionHost({}) }).run();
		expect(status.phase).toBe("paused");
	});

	it("blocks after restart when a round artifact exists without an atomic round completion", async () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		store.append({ type: "effect_intent", effectId: "plan", kind: "plan" });
		const planArtifact = store.writeArtifact("plan", "plan", {
			value: parseSolPlan(PLAN),
			result: promptResult(PLAN),
		});
		store.append({
			type: "effect_completed",
			effectId: "plan",
			kind: "plan",
			artifact: planArtifact,
			artifactDigest: store.artifactDigest(planArtifact),
		});
		store.append({ type: "phase_changed", from: "planning", to: "executing", reason: "planned" });
		const sessionFile = `${store.sessionsDir}/executor.jsonl`;
		writeFileSync(sessionFile, "session evidence\n");
		store.append({
			type: "session_registered",
			session: {
				id: "executor",
				role: "executor",
				file: sessionFile,
				provider: "test",
				modelId: "terra",
				thinkingLevel: "high",
				createdAt: new Date().toISOString(),
			},
		});
		store.append({ type: "effect_intent", effectId: "round", kind: "round", sessionId: "executor" });
		store.writeArtifact("round", "round", { value: parseTerraReport(report("complete"), []) });

		const sessions = new FakeSessionHost({});
		let commandCalls = 0;
		const reopened = RunStore.open(store.runDir);
		const status = await new LongHorizonSupervisor(reopened, {
			sessionHost: sessions,
			commandRunner: async () => {
				commandCalls++;
				throw new Error("acceptance must not run");
			},
		}).run();
		expect(status.phase).toBe("blocked");
		expect(status.pendingEffect).toMatchObject({ effectId: "round", kind: "round" });
		expect(status.rounds).toBe(0);
		expect(commandCalls).toBe(0);
		expect(sessions.prompts).toHaveLength(0);
	});
});
