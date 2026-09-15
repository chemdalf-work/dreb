import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getPackageDir, PRODUCT_NAME, UPSTREAM_BASELINE, VERSION } from "./config.js";

export interface BuildProvenance {
	product: string;
	version: string;
	sourceCommit: string;
	dirty: boolean | null;
	executablePath: string;
	packagePath: string;
	upstreamBaseline: string;
}

interface BuildMetadata {
	product: string;
	version: string;
	sourceCommit: string;
	dirty: boolean;
	upstreamBaseline: string;
}

function isBuildMetadata(value: unknown): value is BuildMetadata {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.product === "string" &&
		typeof record.version === "string" &&
		typeof record.sourceCommit === "string" &&
		typeof record.dirty === "boolean" &&
		typeof record.upstreamBaseline === "string"
	);
}

function readBuildMetadata(packagePath: string): BuildMetadata | undefined {
	const candidates = [join(packagePath, "dist", "build-info.json"), join(packagePath, "build-info.json")];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
			if (isBuildMetadata(parsed)) return parsed;
		} catch {
			// Try the next supported package layout. Diagnostics exposes unknown fields if none are valid.
		}
	}
	return undefined;
}

export function getBuildProvenance(): BuildProvenance {
	const packagePath = resolve(getPackageDir());
	const metadata = readBuildMetadata(packagePath);
	const executablePath = resolve(process.argv[1] || process.execPath);

	return {
		product: metadata?.product ?? PRODUCT_NAME,
		version: metadata?.version ?? VERSION,
		sourceCommit: metadata?.sourceCommit ?? "unknown",
		dirty: metadata?.dirty ?? null,
		executablePath,
		packagePath,
		upstreamBaseline: metadata?.upstreamBaseline ?? UPSTREAM_BASELINE,
	};
}
