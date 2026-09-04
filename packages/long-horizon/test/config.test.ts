import { describe, expect, it } from "vitest";
import { normalizeRunConfig, validateThinkingCapability } from "../src/config.js";

const roles = {
	planner: { provider: "p", modelId: "sol", thinkingLevel: "max" as const },
	executor: { provider: "p", modelId: "terra", thinkingLevel: "high" as const },
	advisor: { provider: "p", modelId: "sol", thinkingLevel: "max" as const },
};

describe("run configuration", () => {
	it("applies durable limits and rollover defaults without mutating input", () => {
		const commands = ["npm test"];
		const config = normalizeRunConfig({ objective: "work", ...roles, acceptanceCommands: commands });
		commands.push("npm run build");
		expect(config.rollover).toEqual({ softTokens: 250_000, strongTokens: 300_000 });
		expect(config.limits.failureThreshold).toBe(3);
		expect(config.acceptanceCommands).toEqual(["npm test"]);
		expect(() => (config.acceptanceCommands as string[]).push("npm run build")).toThrow();
	});

	it("rejects invalid thresholds, limits, and acceptance", () => {
		expect(() =>
			normalizeRunConfig({
				objective: "work",
				...roles,
				acceptanceCommands: [],
				rollover: { softTokens: 10, strongTokens: 10 },
			}),
		).toThrow();
		expect(() =>
			normalizeRunConfig({ objective: "work", ...roles, acceptanceCommands: ["x"], limits: { maxRounds: 0 } }),
		).toThrow(/maxRounds/);
		expect(() =>
			normalizeRunConfig({ objective: "work", ...roles, acceptanceCommands: ["npm test && rm -rf /"] }),
		).toThrow(/shell operators/);
	});

	it("rejects malformed JSON values and unknown fields at runtime", () => {
		expect(() =>
			normalizeRunConfig({
				objective: "work",
				...roles,
				acceptanceCommands: ["npm test"],
				limits: { maxRounds: 1.5 },
			}),
		).toThrow(/integer/);
		expect(() =>
			normalizeRunConfig({
				objective: "work",
				...roles,
				acceptanceCommands: ["npm test"],
				planner: { ...roles.planner, thinkingLevel: "turbo" },
			} as any),
		).toThrow(/thinkingLevel/);
		expect(() =>
			normalizeRunConfig({ objective: "work", ...roles, acceptanceCommands: ["npm test"], surprise: true } as any),
		).toThrow(/unknown fields/);
	});

	it("fails when exact max thinking would be clamped", () => {
		const model = { provider: "p", id: "sol", name: "Sol", api: "openai-responses", reasoning: true } as any;
		expect(() => validateThinkingCapability(roles.planner, model)).toThrow(/max/);
	});
});
