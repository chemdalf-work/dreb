import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const repositoryDir = resolve(packageDir, "../..");
const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

function git(...args) {
	return execFileSync("git", args, {
		cwd: repositoryDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

const sourceCommit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no").length > 0;
const upstreamBaseline = packageJson.drebConfig?.upstreamBaseline;
if (typeof upstreamBaseline !== "string" || upstreamBaseline.length === 0) {
	throw new Error("packages/coding-agent/package.json must define drebConfig.upstreamBaseline");
}

const buildInfo = {
	product: packageJson.drebConfig?.displayName ?? packageJson.drebConfig?.name ?? packageJson.name,
	version: packageJson.version,
	sourceCommit,
	dirty,
	upstreamBaseline,
};

const outputPath = join(packageDir, "dist", "build-info.json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
console.log(`generated ${outputPath}`);
