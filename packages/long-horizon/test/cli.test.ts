import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { RunStore } from "../src/run-store.js";
import { LongHorizonSupervisor } from "../src/supervisor.js";
import { testConfig } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("CLI controls", () => {
	it("prints status and persists pause/abort controls", async () => {
		const paused = RunStore.create(testConfig());
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await main(["status", paused.runDir]);
		await main(["pause", paused.runDir, "hold"]);
		expect(paused.replay().pendingControl).toBe("pause");

		const aborted = RunStore.create(testConfig());
		await main(["abort", aborted.runDir, "stop"]);
		expect(aborted.replay().pendingControl).toBe("abort");
	});

	it("reports durable handoff and escalation histories through the API and CLI", async () => {
		const store = RunStore.create(testConfig());
		const handoffArtifact = store.writeArtifact("handoff", "handoff-1", {
			schemaVersion: 1,
			fromSessionId: "executor-1",
			workUnitId: "unit",
			strategyId: "strategy-a",
			summary: "checkpoint",
			nextAction: "continue",
			evidenceIds: [],
			createdAt: new Date().toISOString(),
		});
		const handoffArtifactDigest = store.artifactDigest(handoffArtifact);
		store.append({ type: "effect_intent", effectId: "handoff-1", kind: "handoff", sessionId: "executor-1" });
		store.append({
			type: "effect_completed",
			effectId: "handoff-1",
			kind: "handoff",
			artifact: handoffArtifact,
			artifactDigest: handoffArtifactDigest,
		});
		for (let attempt = 0; attempt <= store.config.limits.failureThreshold; attempt++) {
			store.append({ type: "failure_recorded", workUnitId: "unit", strategyId: "strategy-a", signature: "failure" });
		}
		const adviceArtifact = store.writeArtifact("advice", "advice-1", { advice: "change approach" });
		const adviceArtifactDigest = store.artifactDigest(adviceArtifact);
		store.append({
			type: "escalation_completed",
			workUnitId: "unit",
			signature: "failure",
			adviceArtifact,
			adviceArtifactDigest,
		});

		const apiStatus = LongHorizonSupervisor.open(store.runDir).status();
		expect(apiStatus.handoffHistory).toEqual([
			expect.objectContaining({
				seq: expect.any(Number),
				timestamp: expect.any(String),
				effectId: "handoff-1",
				fromSessionId: "executor-1",
				artifact: handoffArtifact,
				artifactDigest: handoffArtifactDigest,
			}),
		]);
		expect(apiStatus.escalationHistory).toEqual([
			expect.objectContaining({
				seq: expect.any(Number),
				timestamp: expect.any(String),
				workUnitId: "unit",
				signature: "failure",
				adviceArtifact,
				adviceArtifactDigest,
			}),
		]);
		expect(apiStatus.handoffHistory[0].seq).toBeLessThan(apiStatus.escalationHistory[0].seq);

		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output.push(String(chunk));
			return true;
		});
		await main(["status", store.runDir]);
		const cliStatus = JSON.parse(output.join(""));
		expect(cliStatus.handoffHistory).toEqual(apiStatus.handoffHistory);
		expect(cliStatus.escalationHistory).toEqual(apiStatus.escalationHistory);
	});

	it("requires an explicit reason before acknowledging an interrupted effect", async () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "effect_intent", effectId: "pending", kind: "round" });
		await expect(main(["resume", store.runDir, "--acknowledge-pending"])).rejects.toThrow(/explicit reason/);
		expect(store.replay().pendingEffect?.effectId).toBe("pending");
	});

	it("returns loud usage errors for malformed commands", async () => {
		await expect(main([])).rejects.toThrow(/Usage/);
		await expect(main(["unknown", "somewhere"])).rejects.toThrow(/Usage/);
		await expect(main(["status", "somewhere", "extra"])).rejects.toThrow(/Usage/);
		await expect(main(["start", "config.json"])).rejects.toThrow(/Usage/);
	});
});
