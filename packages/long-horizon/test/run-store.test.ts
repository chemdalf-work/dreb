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
