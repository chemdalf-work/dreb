import { type ExecFileException, execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Walk upward from `cwd` looking for a `.git` directory or file (worktrees use a `.git` file).
 * Returns the directory containing `.git`, or `null` if not in a git repo.
 */
export function findGitRoot(cwd: string): string | null {
	let current = resolve(cwd);
	const root = resolve("/");

	while (true) {
		const gitPath = join(current, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isDirectory() || stat.isFile()) {
					return current;
				}
			} catch {
				// stat failed, keep walking
			}
		}

		if (current === root) break;
		const parent = resolve(current, "..");
		if (parent === current) break;
		current = parent;
	}

	return null;
}

/**
 * Resolve and verify the current Git worktree root.
 * Unlike findGitRoot(), this rejects arbitrary or malformed `.git` markers.
 */
export async function findVerifiedGitRoot(cwd: string): Promise<string | null> {
	const candidate = findGitRoot(cwd);
	if (!candidate) return null;

	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["-C", resolve(cwd), "rev-parse", "--show-toplevel"],
			{ encoding: "utf8", timeout: 5000, maxBuffer: 4096 },
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}

				const reportedRoot = stdout.trim();
				if (!reportedRoot) {
					resolvePromise(null);
					return;
				}
				try {
					const verifiedRoot = realpathSync(reportedRoot);
					resolvePromise(verifiedRoot === realpathSync(candidate) ? verifiedRoot : null);
				} catch {
					resolvePromise(null);
				}
			},
		);
	});
}
