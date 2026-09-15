import { describe, expect, it } from "vitest";
import { type BuildProvenance, getBuildProvenance } from "../src/build-provenance.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.js";
import { formatDiagnostics } from "../src/diagnostics.js";

const fixture: BuildProvenance = {
	product: "Pierre Dreb",
	version: "2.66.0",
	sourceCommit: "0123456789abcdef",
	dirty: false,
	executablePath: "/opt/pierre-dreb/dist/cli.js",
	packagePath: "/opt/pierre-dreb",
	upstreamBaseline: "aebrer/dreb@52583b0",
};

describe("build provenance", () => {
	it("renders the same complete model as text and JSON", () => {
		const text = formatDiagnostics(fixture);
		expect(text).toContain("Pierre Dreb diagnostics");
		expect(text).toContain("source commit: 0123456789abcdef");
		expect(text).toContain("dirty build: no");
		expect(text).toContain("upstream baseline: aebrer/dreb@52583b0");
		expect(JSON.parse(formatDiagnostics(fixture, true))).toEqual(fixture);
	});

	it("contains only declared provenance fields and never serializes environment values", () => {
		process.env.PIERRE_DREB_PROVENANCE_TEST_SECRET = "must-not-leak";
		try {
			const provenance = getBuildProvenance();
			expect(Object.keys(provenance).sort()).toEqual(
				["dirty", "executablePath", "packagePath", "product", "sourceCommit", "upstreamBaseline", "version"].sort(),
			);
			expect(JSON.stringify(provenance)).not.toContain("must-not-leak");
		} finally {
			delete process.env.PIERRE_DREB_PROVENANCE_TEST_SECRET;
		}
	});

	it("stores provenance in newly created versioned session headers", () => {
		const manager = SessionManager.inMemory("/tmp/pierre-dreb-project");
		const header = manager.getHeader();

		expect(CURRENT_SESSION_VERSION).toBe(4);
		expect(header).toMatchObject({
			type: "session",
			version: 4,
			cwd: "/tmp/pierre-dreb-project",
			provenance: {
				product: "Pierre Dreb",
				version: "2.66.0",
				upstreamBaseline: "aebrer/dreb@52583b0",
			},
		});
	});
});
