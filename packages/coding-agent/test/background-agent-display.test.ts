import { describe, expect, it } from "vitest";
import type { BackgroundAgentInfo } from "../src/core/tools/subagent.js";
import { formatBackgroundAgentRow } from "../src/modes/interactive/background-agent-display.js";

const agent: BackgroundAgentInfo = {
	agentId: "child-1",
	agentType: "feature-dev",
	taskSummary: "Implement the complete descendant telemetry surface without losing status",
	startedAt: 1,
	status: "aborted",
	parentAgentId: "parent-1",
	provider: "anthropic",
	model: "claude-sonnet",
	thinking: "high",
	usage: { input: 12_345, output: 678, cacheRead: 9_000, cacheWrite: 12, cost: 0.4321 },
};

describe("formatBackgroundAgentRow", () => {
	it("shows hierarchy, status, token split, cost, provider/model, and thinking", () => {
		const row = formatBackgroundAgentRow(agent, 200);
		expect(row).toContain("↳ [aborted] feature-dev");
		expect(row).toContain("in 12.3k · out 678 · cache 9.0k/12 · $0.4321");
		expect(row).toContain("anthropic/claude-sonnet @ high");
	});

	it("truncates only the task label on narrow terminals", () => {
		const row = formatBackgroundAgentRow(agent, 60);
		expect(row).toContain("[aborted]");
		expect(row).toContain("$0.4321");
		expect(row).toContain("anthropic/claude-sonnet @ high");
		expect(row).toContain("…");
	});
});
