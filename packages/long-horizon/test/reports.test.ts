import { describe, expect, it } from "vitest";
import {
	normalizeFailure,
	parseSolPlan,
	parseTerraReport,
	validateHandoffArtifact,
	validateSolAdvice,
	validateSolPlan,
} from "../src/reports.js";
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
		const failed = report("verification-failed", '"failure":{"operation":"test","diagnostic":"boom"},');
		expect(() => parseTerraReport(failed, [])).toThrow(/failing tool evidence/);
	});

	it("accepts the issue status vocabulary and rejects legacy statuses", () => {
		const evidence = { id: "failed-command", exitCode: 1 };
		const verificationFailed = report("failed", '"failure":{"operation":"test","diagnostic":"boom"},')
			.replace('"status":"failed"', '"status":"verification-failed"')
			.replace('"evidenceIds":[]', '"evidenceIds":["failed-command"]');
		expect(parseTerraReport(verificationFailed, [evidence]).status).toBe("verification-failed");
		expect(() =>
			parseTerraReport(report("failed", '"failure":{"operation":"test","diagnostic":"boom"},'), [evidence]),
		).toThrow(/invalid report status/);
		expect(() => parseTerraReport(report("handoff_ready"), [])).toThrow(/invalid report status/);
	});

	it("keeps handoff readiness orthogonal to status and rejects contradictory failure fields", () => {
		const handoffReady = report("progress").replace('"handoffReady":false', '"handoffReady":true');
		expect(parseTerraReport(handoffReady, []).handoffReady).toBe(true);
		expect(() =>
			parseTerraReport(report("progress", '"failure":{"operation":"test","diagnostic":"boom"},'), []),
		).toThrow(/only verification-failed reports/);
	});

	it("strictly validates persisted plan, advice, and handoff schemas", () => {
		const plan = parseSolPlan(PLAN);
		expect(() => validateSolPlan({ ...plan, injected: true })).toThrow(/unknown fields/);
		expect(() =>
			validateSolAdvice({
				schemaVersion: 1,
				workUnitId: "unit",
				failureSignature: "signature",
				strategyId: "strategy-b",
				advice: "change approach",
				injected: true,
			}),
		).toThrow(/unknown fields/);
		expect(() =>
			validateHandoffArtifact({
				schemaVersion: 1,
				fromSessionId: 42,
				workUnitId: "unit",
				strategyId: "strategy-a",
				summary: "checkpoint",
				nextAction: "continue",
				evidenceIds: [],
				createdAt: new Date().toISOString(),
			}),
		).toThrow(/fromSessionId/);
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
