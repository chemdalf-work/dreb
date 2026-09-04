import { describe, expect, it } from "vitest";
import { normalizeFailure, parseSolPlan, parseTerraReport } from "../src/reports.js";
import { PLAN, report } from "./helpers.js";

describe("structured reports", () => {
	it("parses versioned plan and report envelopes", () => {
		expect(parseSolPlan(PLAN).workUnits[0].id).toBe("unit");
		expect(parseTerraReport(report("progress"), []).status).toBe("progress");
	});

	it("rejects malformed, missing, and invented evidence", () => {
		expect(() => parseSolPlan("{}")).toThrow();
		const text = report("progress").replace('"evidenceIds":[]', '"evidenceIds":["invented"]');
		expect(() => parseTerraReport(text, [])).toThrow(/unknown evidence/);
		const failed = report("failed", '"failure":{"operation":"test","diagnostic":"boom"},');
		expect(() => parseTerraReport(failed, [])).toThrow(/failing tool evidence/);
	});

	it("rejects contradictory handoff and failure fields", () => {
		expect(() =>
			parseTerraReport(report("handoff_ready").replace('"handoffReady":true', '"handoffReady":false'), []),
		).toThrow(/handoffReady=true/);
		expect(() =>
			parseTerraReport(report("progress", '"failure":{"operation":"test","diagnostic":"boom"},'), []),
		).toThrow(/only failed reports/);
	});

	it("normalizes cosmetic failure differences deterministically", () => {
		const a = normalizeFailure({
			operation: "test",
			command: "npm   test",
			exitCode: 1,
			diagnostic: "/tmp/a/file.ts failed at 2026-09-04T12:00:00Z pid 123456",
		});
		const b = normalizeFailure({
			operation: "test",
			command: "npm test",
			exitCode: 1,
			diagnostic: "/tmp/b/file.ts failed at 2026-09-05T13:00:00Z pid 999999",
		});
		expect(a).toBe(b);
	});
});
