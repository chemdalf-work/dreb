import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { digest, RunStore } from "../src/run-store.js";
import { testConfig } from "./helpers.js";

describe("RunStore", () => {
	it("appends, replays, and atomically maintains its derived snapshot", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		const state = store.replay();
		expect(state.phase).toBe("planning");
		expect(JSON.parse(readFileSync(store.snapshotPath, "utf8"))).toEqual(state);
		expect(RunStore.open(store.runDir).replay()).toEqual(state);
	});

	it("repairs a valid stale snapshot from the authoritative journal", () => {
		const store = RunStore.create(testConfig());
		const stale = readFileSync(store.snapshotPath, "utf8");
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		writeFileSync(store.snapshotPath, stale);
		const reopened = RunStore.open(store.runDir);
		expect(reopened.replay().phase).toBe("planning");
		expect(JSON.parse(readFileSync(store.snapshotPath, "utf8")).phase).toBe("planning");
	});

	it("fails closed on a truncated or checksummed journal", () => {
		const truncated = RunStore.create(testConfig());
		appendFileSync(truncated.journalPath, "{");
		expect(() => truncated.replay()).toThrow(/truncated/);

		const corrupt = RunStore.create(testConfig());
		const text = readFileSync(corrupt.journalPath, "utf8").replace("run_created", "run_broken");
		writeFileSync(corrupt.journalPath, text);
		expect(() => corrupt.replay()).toThrow(/checksum/);
	});

	it("fails closed on an unknown checksummed event", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		const records = readFileSync(store.journalPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		records[1].event = { type: "future_event" };
		const { hash: _oldHash, ...unsigned } = records[1];
		records[1].hash = digest(unsigned);
		writeFileSync(store.journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		expect(() => store.replay()).toThrow(/unknown journal event/);
	});

	it("rejects malformed event payloads before appending", () => {
		const store = RunStore.create(testConfig());
		const before = readFileSync(store.journalPath, "utf8");
		expect(() => store.append({ type: "usage_recorded", role: "planner", tokens: Number.NaN, costUsd: 0 })).toThrow(
			/usage_recorded\.tokens/,
		);
		expect(() =>
			store.append({ type: "usage_recorded", role: "planner", tokens: 1, costUsd: Number.POSITIVE_INFINITY }),
		).toThrow(/usage_recorded\.costUsd/);
		expect(() => store.append({ type: "control_requested", action: "pause", unexpected: true } as never)).toThrow(
			/unknown fields/,
		);
		expect(readFileSync(store.journalPath, "utf8")).toBe(before);
	});

	it("rejects a checksummed journal event with a malformed payload during replay", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "usage_recorded", role: "planner", tokens: 5, costUsd: 0.25 });
		const records = readFileSync(store.journalPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		records[1].event.tokens = "unbounded";
		const { hash: _oldHash, ...unsigned } = records[1];
		records[1].hash = digest(unsigned);
		writeFileSync(store.journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		expect(() => store.replay()).toThrow(/usage_recorded\.tokens/);
	});

	it("rejects an artifact whose content no longer matches its journal-bound digest", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "effect_intent", effectId: "tamper-test", kind: "plan" });
		const artifact = store.writeArtifact("plan", "tamper-test", { value: "original" });
		const expectedDigest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
		store.append({
			type: "effect_completed",
			effectId: "tamper-test",
			kind: "plan",
			artifact,
			artifactDigest: expectedDigest,
		});
		writeFileSync(artifact, '{"value":"mutated"}\n');

		expect(() => store.readArtifact(artifact, expectedDigest)).toThrow(/artifact integrity/);
		expect(() => RunStore.open(store.runDir)).toThrow(/artifact integrity/);
	});

	it("requires a content digest whenever an artifact path is journaled", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "effect_intent", effectId: "unbound", kind: "plan" });
		const artifact = store.writeArtifact("plan", "unbound", { value: "unbound" });
		expect(() => store.append({ type: "effect_completed", effectId: "unbound", kind: "plan", artifact })).toThrow(
			/recorded together/,
		);
	});

	it("requires completed handoffs to identify the same source session as their durable artifact", () => {
		const missingSource = RunStore.create(testConfig());
		expect(() => missingSource.append({ type: "effect_intent", effectId: "handoff", kind: "handoff" })).toThrow(
			/sessionId is required for a handoff intent/,
		);

		const missingArtifact = RunStore.create(testConfig());
		missingArtifact.append({
			type: "effect_intent",
			effectId: "handoff",
			kind: "handoff",
			sessionId: "executor-1",
		});
		expect(() => missingArtifact.append({ type: "effect_completed", effectId: "handoff", kind: "handoff" })).toThrow(
			/required for a handoff completion/,
		);

		const mismatched = RunStore.create(testConfig());
		mismatched.append({
			type: "effect_intent",
			effectId: "handoff",
			kind: "handoff",
			sessionId: "executor-1",
		});
		const artifact = mismatched.writeArtifact("handoff", "handoff", {
			schemaVersion: 1,
			fromSessionId: "executor-2",
			workUnitId: "unit",
			strategyId: "strategy-a",
			summary: "checkpoint",
			nextAction: "continue",
			evidenceIds: [],
			createdAt: new Date().toISOString(),
		});
		expect(() =>
			mismatched.append({
				type: "effect_completed",
				effectId: "handoff",
				kind: "handoff",
				artifact,
				artifactDigest: mismatched.artifactDigest(artifact),
			}),
		).toThrow(/does not match the handoff artifact source session/);
	});

	it("rejects a handoff source mismatch when reopening a rewritten journal and artifact", () => {
		const store = RunStore.create(testConfig());
		store.append({
			type: "effect_intent",
			effectId: "handoff",
			kind: "handoff",
			sessionId: "executor-1",
		});
		const handoff = {
			schemaVersion: 1,
			fromSessionId: "executor-1",
			workUnitId: "unit",
			strategyId: "strategy-a",
			summary: "checkpoint",
			nextAction: "continue",
			evidenceIds: [],
			createdAt: new Date().toISOString(),
		};
		const artifact = store.writeArtifact("handoff", "handoff", handoff);
		store.append({
			type: "effect_completed",
			effectId: "handoff",
			kind: "handoff",
			artifact,
			artifactDigest: store.artifactDigest(artifact),
		});

		writeFileSync(artifact, `${JSON.stringify({ ...handoff, fromSessionId: "executor-2" }, null, 2)}\n`);
		const records = readFileSync(store.journalPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		records[2].event.artifactDigest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
		const { hash: _oldHash, ...unsigned } = records[2];
		records[2].hash = digest(unsigned);
		writeFileSync(store.journalPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		unlinkSync(store.snapshotPath);

		expect(() => RunStore.open(store.runDir)).toThrow(/does not match the handoff artifact source session/);
	});

	it("rejects an ambiguous live lock and concurrent supervisor ownership", () => {
		const store = RunStore.create(testConfig());
		writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid }));
		expect(() => store.append({ type: "control_requested", action: "pause" })).toThrow(/locked/);
		unlinkSync(store.lockPath);
		const release = store.acquireOwnership();
		try {
			expect(() => store.acquireOwnership()).toThrow(/locked/);
		} finally {
			release();
		}
	});
});
