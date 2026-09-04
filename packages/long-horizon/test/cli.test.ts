import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { RunStore } from "../src/run-store.js";
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
