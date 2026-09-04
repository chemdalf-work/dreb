import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RunStore } from "../src/run-store.js";
import { LongHorizonSupervisor } from "../src/supervisor.js";
import { FakeSessionHost, testConfig } from "./helpers.js";

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
});
