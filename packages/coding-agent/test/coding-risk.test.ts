import { describe, expect, test } from "vitest";
import { classifyCodingRisk } from "../src/core/coding-risk.js";

describe("classifyCodingRisk", () => {
	test.each([
		["Inspect the repository and locate the parser", "bounded-research"],
		["Summarize the current implementation", "bounded-research"],
	] as const)("classifies bounded read-only work as low risk: %s", (task, signal) => {
		expect(classifyCodingRisk({ task, tools: ["read", "grep", "search"] })).toEqual({
			level: "low",
			signals: [signal],
		});
	});

	test("classifies ordinary implementation as medium risk", () => {
		expect(classifyCodingRisk({ task: "Implement the footer change", tools: ["read", "edit", "write"] })).toEqual({
			level: "medium",
			signals: ["implementation", "write-capable-profile"],
		});
	});

	test("a write-capable profile raises otherwise unclassified work to medium risk", () => {
		expect(classifyCodingRisk({ task: "Handle the requested work", tools: ["read", "write"] })).toEqual({
			level: "medium",
			signals: ["write-capable-profile"],
		});
	});

	test.each([
		["Fix OAuth credential handling", "security-surface"],
		["Modify RBAC role assignments", "security-surface"],
		["Grant RBAC permissions", "security-surface"],
		["Change the ACL access-control rules", "security-surface"],
		["Replace ACL rules", "security-surface"],
		["Rotate the JWT signing key", "security-surface"],
		["Create a JWT signing key", "security-surface"],
		["Configure OAuth access control", "security-surface"],
		["Migrate the database schema", "data-migration"],
		["Fix the concurrency race condition", "concurrency"],
		["Delete production records", "destructive-operation"],
		["Safely delete production records", "destructive-operation"],
		["Change the public API wire format", "protocol-compatibility"],
		["Upgrade the public API wire format", "protocol-compatibility"],
		["Publish the production release", "release-surface"],
	] as const)("classifies sensitive changes as high risk: %s", (task, signal) => {
		const assessment = classifyCodingRisk({ task, tools: ["read", "edit", "write"] });
		expect(assessment.level).toBe("high");
		expect(assessment.signals).toContain(signal);
		expect(assessment.signals.join(" ")).not.toContain(task);
	});

	test.each([
		"Investigate the OAuth auth flow",
		"Research how to configure OAuth",
		"Find all code paths that delete records",
		"Investigate how deletion is protected",
		"Investigate whether we should delete production records",
	])("keeps bounded read-only sensitive research low risk: %s", (task) => {
		expect(classifyCodingRisk({ task, tools: ["read", "search"] })).toEqual({
			level: "low",
			signals: ["bounded-research"],
		});
	});

	test("does not let a research prefix hide an explicit follow-on mutation", () => {
		expect(
			classifyCodingRisk({ task: "Investigate OAuth and then configure access control", tools: ["read", "search"] }),
		).toEqual({ level: "high", signals: ["security-surface"] });
	});

	test("deduplicates high-risk signals in stable rule order without exposing task text", () => {
		const task = "Delete production OAuth credentials and change the public API wire format";
		const assessment = classifyCodingRisk({ task, tools: ["read", "edit"] });
		expect(assessment).toEqual({
			level: "high",
			signals: ["destructive-operation", "security-surface", "protocol-compatibility", "release-surface"],
		});
		expect(assessment.signals.join(" ")).not.toContain(task);
	});

	test("defaults ambiguous work to medium risk", () => {
		expect(classifyCodingRisk({ task: "Handle this request", tools: ["read"] })).toEqual({
			level: "medium",
			signals: ["unclassified"],
		});
	});
});
