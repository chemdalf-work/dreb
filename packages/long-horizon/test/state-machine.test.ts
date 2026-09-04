import { describe, expect, it } from "vitest";
import { RunStore } from "../src/run-store.js";
import { selectNextAction } from "../src/state-machine.js";
import { testConfig } from "./helpers.js";

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

	it("never accepts duplicate side-effect intent or completion", () => {
		const store = RunStore.create(testConfig());
		store.append({ type: "effect_intent", effectId: "a", kind: "plan" });
		expect(selectNextAction(store.replay(), store.config)).toBe("reconcile");
		expect(() => store.append({ type: "effect_intent", effectId: "b", kind: "plan" })).toThrow(/still pending/);
		expect(() => store.append({ type: "effect_completed", effectId: "b", kind: "plan" })).toThrow(/matching intent/);
		store.acknowledgePendingEffect("operator inspected workspace");
		expect(store.replay().pendingEffect).toBeUndefined();
	});

	it("applies budget limits before ordinary execution", () => {
		const config = testConfig({ limits: { ...testConfig().limits, maxTotalTokens: 5 } });
		const store = RunStore.create(config);
		store.append({ type: "phase_changed", from: "created", to: "planning", reason: "start" });
		store.append({ type: "usage_recorded", role: "planner", tokens: 5, costUsd: 0 });
		expect(selectNextAction(store.replay(), config)).toBe("fail-budget");
	});
});
