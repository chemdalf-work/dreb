import { describe, expect, it } from "vitest";
import { parseTerraReport } from "../src/reports.js";
import { RunStore } from "../src/run-store.js";
import { selectNextAction } from "../src/state-machine.js";
import { commandEvidence, report, testConfig } from "./helpers.js";

describe("state machine", () => {
	it("enforces transitions and control precedence", () => {
		const store = RunStore.create(testConfig());
		expect(selectNextAction(store.replay(), store.config)).toBe("plan");
		store.append({ type: "control_requested", action: "pause" });
		expect(selectNextAction(store.replay(), store.config)).toBe("pause");
		expect(() => store.append({ type: "phase_changed", from: "created", to: "completed", reason: "skip" })).toThrow(
			/invalid phase/,
		);
	});

	it("keeps an abort request monotonic over later pause and resume controls", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "control_requested", action: "abort", reason: "stop now" });
		store.append({ type: "control_requested", action: "pause", reason: "late pause" });
		expect(store.replay().pendingControl).toBe("abort");
		expect(selectNextAction(store.replay(), store.config)).toBe("abort");

		store.append({ type: "phase_changed", from: "created", to: "paused", reason: "stale pause handler" });
		expect(store.replay().pendingControl).toBe("abort");

		store.append({ type: "control_requested", action: "resume", reason: "late resume" });
		expect(store.replay().pendingControl).toBe("abort");
		expect(selectNextAction(store.replay(), store.config)).toBe("abort");
	});

	it("never accepts duplicate side-effect intent or completion", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "effect_intent", effectId: "a", kind: "plan" });
		expect(selectNextAction(store.replay(), store.config)).toBe("reconcile");
		expect(() => store.append({ type: "effect_intent", effectId: "b", kind: "plan" })).toThrow(/still pending/);
		expect(() => store.append({ type: "effect_completed", effectId: "b", kind: "plan" })).toThrow(/matching intent/);
		store.acknowledgePendingEffect("operator inspected workspace");
		expect(store.replay().pendingEffect).toBeUndefined();
	});

	it("commits a round effect and its accounting in one journal transition", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "effect_intent", effectId: "round-a", kind: "round" });
		const artifact = store.writeArtifact("round", "round-a", { value: parseTerraReport(report("progress"), []) });
		const artifactDigest = store.artifactDigest(artifact);
		expect(() =>
			store.append({ type: "effect_completed", effectId: "round-a", kind: "round", artifact, artifactDigest }),
		).toThrow(/must commit through round_completed/);
		const state = store.append({
			type: "round_completed",
			effectId: "round-a",
			artifact,
			artifactDigest,
			round: 1,
			report: parseTerraReport(report("progress"), []),
			verificationSucceeded: false,
		});
		expect(state.pendingEffect).toBeUndefined();
		expect(state.rounds).toBe(1);
	});

	it("checkpoints acceptance and final verification in journal order", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "effect_intent", effectId: "round-complete", kind: "round" });
		const roundArtifact = store.writeArtifact("round", "round-complete", {
			value: parseTerraReport(report("complete"), []),
		});
		store.append({
			type: "round_completed",
			effectId: "round-complete",
			artifact: roundArtifact,
			artifactDigest: store.artifactDigest(roundArtifact),
			round: 1,
			report: parseTerraReport(report("complete"), []),
			verificationSucceeded: false,
		});

		store.append({ type: "effect_intent", effectId: "acceptance", kind: "acceptance" });
		const evidence = commandEvidence("npm test", "workspace");
		store.append({
			type: "acceptance_recorded",
			effectId: "acceptance",
			round: 1,
			commandIndex: 0,
			evidence,
		});
		const acceptanceArtifact = store.writeArtifact("acceptance", "acceptance", { evidence: [evidence] });
		const accepted = store.append({
			type: "acceptance_completed",
			effectId: "acceptance",
			artifact: acceptanceArtifact,
			artifactDigest: store.artifactDigest(acceptanceArtifact),
			round: 1,
			status: "passed",
			evidenceIds: [evidence.id],
			workspaceIdentity: "workspace",
		});
		expect(accepted.pendingEffect).toBeUndefined();
		expect(accepted.acceptanceCheckpoint?.status).toBe("passed");

		const verificationArtifact = store.writeArtifact("final-verification", "final", { value: "accepted" });
		const verified = store.append({
			type: "final_verification_recorded",
			round: 1,
			accepted: true,
			artifact: verificationArtifact,
			artifactDigest: store.artifactDigest(verificationArtifact),
		});
		expect(verified.finalVerification?.accepted).toBe(true);
		expect(() =>
			store.append({
				type: "acceptance_reset",
				round: 2,
				stage: "commands",
				retryFrom: 0,
				reason: "invalid future reset",
			}),
		).toThrow(/invalid round/);
	});

	it("applies budget limits before ordinary execution", () => {
		const config = testConfig({ limits: { ...testConfig().limits, maxTotalTokens: 5 } });
		const store = RunStore.create(config);
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		store.append({ type: "usage_recorded", role: "planner", tokens: 5, costUsd: 0 });
		expect(selectNextAction(store.replay(), config)).toBe("fail-budget");
	});
});
