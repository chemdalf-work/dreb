import { type BuildProvenance, getBuildProvenance } from "./build-provenance.js";
import { CLI_NAME } from "./config.js";

export function formatDiagnostics(provenance: BuildProvenance, json = false): string {
	if (json) return `${JSON.stringify(provenance)}\n`;

	const dirty = provenance.dirty === null ? "unknown" : provenance.dirty ? "yes" : "no";
	return [
		`${provenance.product} diagnostics`,
		`version: ${provenance.version}`,
		`source commit: ${provenance.sourceCommit}`,
		`dirty build: ${dirty}`,
		`executable: ${provenance.executablePath}`,
		`package path: ${provenance.packagePath}`,
		`upstream baseline: ${provenance.upstreamBaseline}`,
		"",
	].join("\n");
}

export function handleDiagnosticsCommand(args: string[]): boolean {
	if (args[0] !== "diagnostics") return false;

	const options = args.slice(1);
	const invalid = options.find((arg) => arg !== "--json");
	if (invalid) {
		process.stderr.write(`Unknown diagnostics option: ${invalid}\nUsage: ${CLI_NAME} diagnostics [--json]\n`);
		process.exitCode = 1;
		return true;
	}

	process.stdout.write(formatDiagnostics(getBuildProvenance(), options.includes("--json")));
	return true;
}
