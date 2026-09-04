import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@dreb/ai";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ToolDefinition,
} from "@dreb/coding-agent";
import type { AuthorizationPolicy, CommandEvidence, SessionRole } from "./types.js";

const DESTRUCTIVE_GIT =
	/(?:^|\s)git\s+(?:push|clean|reset\s+--hard|checkout\s+--|restore\s+--source|branch\s+-D|tag\s+-d)(?:\s|$)/i;
const RELEASE = /(?:^|\s)(?:npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|gh\s+release)(?:\s|$)/i;
const DEPLOY =
	/(?:^|\s)(?:kubectl\s+(?:apply|delete)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy)|vercel\s+deploy)(?:\s|$)/i;
const CREDENTIALS = /(?:^|[\s/])(?:\.env|credentials?|secrets?|id_rsa|id_ed25519)(?:\s|$)/i;
const REMOTE_STATE =
	/(?:^|\s)(?:gh\s+(?:pr|issue)\s+(?:create|edit|close|merge|comment)|curl\s+.*(?:-X\s*)?(?:POST|PUT|PATCH|DELETE))(?:\s|$)/i;

/** Parse a command into executable/argv without invoking a shell. */
export function parseCommand(command: string): string[] {
	const result: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let started = false;
	for (const character of command.trim()) {
		if (escaped) {
			token += character;
			escaped = false;
			started = true;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else token += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (started) {
				result.push(token);
				token = "";
				started = false;
			}
			continue;
		}
		if (";&|<>`".includes(character) || (character === "$" && command.includes("$("))) {
			throw new Error("shell operators and substitutions are not supported");
		}
		token += character;
		started = true;
	}
	if (escaped || quote) throw new Error("unterminated command quote or escape");
	if (started) result.push(token);
	if (result.length === 0 || !result[0]) throw new Error("empty command is not authorized");
	return result;
}

function commandKey(command: string): string {
	return JSON.stringify(parseCommand(command));
}

export function assertCommandAuthorized(command: string, policy: AuthorizationPolicy): void {
	const argv = parseCommand(command);
	const normalized = argv.join(" ");
	const allowed = new Set(policy.allowedCommands.map(commandKey));
	if (!allowed.has(JSON.stringify(argv))) throw new Error(`command is not explicitly authorized: ${normalized}`);
	if (!policy.allowDestructiveGit && DESTRUCTIVE_GIT.test(normalized))
		throw new Error("destructive git command denied");
	if (!policy.allowRelease && RELEASE.test(normalized)) throw new Error("release command denied");
	if (!policy.allowDeploy && DEPLOY.test(normalized)) throw new Error("deployment command denied");
	if (!policy.allowCredentials && CREDENTIALS.test(normalized)) throw new Error("credential access denied");
	if (!policy.allowRemoteState && REMOTE_STATE.test(normalized)) throw new Error("remote-state mutation denied");
}

function bounded(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value);
	if (bytes.length <= maxBytes) return value;
	return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[output truncated at ${maxBytes} bytes]`;
}

interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	termination?: "timeout" | "aborted";
}

function executeProcess(
	executable: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	maxOutputBytes: number,
	signal?: AbortSignal,
): Promise<ProcessResult> {
	return new Promise((resolvePromise, reject) => {
		const grouped = process.platform !== "win32";
		const child = spawn(executable, args, {
			cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: grouped,
		});
		let stdout = "";
		let stderr = "";
		let termination: ProcessResult["termination"];
		let killTimer: NodeJS.Timeout | undefined;
		child.stdout.on("data", (chunk) => {
			stdout = bounded(stdout + String(chunk), maxOutputBytes);
		});
		child.stderr.on("data", (chunk) => {
			stderr = bounded(stderr + String(chunk), maxOutputBytes);
		});
		const kill = (signalName: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				if (grouped) process.kill(-child.pid, signalName);
				else child.kill(signalName);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		const terminate = (reason: "timeout" | "aborted") => {
			if (termination) return;
			termination = reason;
			kill("SIGTERM");
			killTimer = setTimeout(() => kill("SIGKILL"), 1000);
			killTimer.unref();
		};
		const timer = setTimeout(() => terminate("timeout"), timeoutMs);
		const abort = () => terminate("aborted");
		signal?.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", abort);
			reject(error);
		});
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", abort);
			resolvePromise({
				exitCode,
				stdout: bounded(stdout, maxOutputBytes),
				stderr: bounded(stderr, maxOutputBytes),
				termination,
			});
		});
	});
}

function gitOutput(cwd: string, args: string[], maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) {
				child.kill("SIGTERM");
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = bounded(stderr + String(chunk), 64 * 1024);
		});
		child.on("error", reject);
		child.on("close", (exitCode) => {
			if (bytes > maxBytes) {
				reject(new Error(`git ${args[0]} output exceeded ${maxBytes} bytes`));
				return;
			}
			if (exitCode !== 0) {
				reject(new Error(`git ${args[0]} failed (${String(exitCode)}): ${stderr.trim()}`));
				return;
			}
			resolvePromise(Buffer.concat(chunks));
		});
	});
}

function gitOutputDigest(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		const hash = createHash("sha256");
		let stderr = "";
		child.stdout.on("data", (chunk) => hash.update(chunk));
		child.stderr.on("data", (chunk) => {
			stderr = bounded(stderr + String(chunk), 64 * 1024);
		});
		child.on("error", reject);
		child.on("close", (exitCode) => {
			if (exitCode !== 0) {
				reject(new Error(`git ${args[0]} failed (${String(exitCode)}): ${stderr.trim()}`));
				return;
			}
			resolvePromise(hash.digest("hex"));
		});
	});
}

function hashFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolvePromise);
	});
}

export async function getWorkspaceIdentity(cwd: string): Promise<string> {
	const root = resolve(cwd);
	const head = await gitOutput(root, ["rev-parse", "HEAD"]);
	const trackedDiff = await gitOutputDigest(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
	const untrackedOutput = await gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	const untracked = untrackedOutput.toString("utf8").split("\0").filter(Boolean).sort();
	const hash = createHash("sha256").update(head).update("\0tracked\0").update(trackedDiff);
	for (const name of untracked) {
		const path = resolve(root, name);
		const contained = relative(root, path);
		if (!contained || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
			throw new Error(`git returned an invalid untracked path: ${name}`);
		}
		const stat = lstatSync(path);
		hash.update("\0untracked\0").update(name).update(`\0${stat.mode}\0${stat.size}\0`);
		if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
		else if (stat.isFile()) await hashFile(hash, path);
		else throw new Error(`unsupported untracked workspace entry: ${name}`);
	}
	return hash.digest("hex");
}

export type CommandRunner = (
	command: string,
	cwd: string,
	policy: AuthorizationPolicy,
	signal?: AbortSignal,
) => Promise<CommandEvidence>;

export const runAuthorizedCommand: CommandRunner = async (command, cwd, policy, signal) => {
	assertCommandAuthorized(command, policy);
	const [executable, ...args] = parseCommand(command);
	const startedAt = new Date().toISOString();
	const result = await executeProcess(executable, args, cwd, policy.commandTimeoutMs, policy.maxOutputBytes, signal);
	return {
		id: randomUUID(),
		command,
		...result,
		startedAt,
		completedAt: new Date().toISOString(),
		workspaceIdentity: await getWorkspaceIdentity(cwd),
	};
};

const authorizedCommandSchema = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });

export function createAuthorizedCommandTool(
	cwd: string,
	policy: AuthorizationPolicy,
	onEvidence: (evidence: CommandEvidence) => void,
	runner: CommandRunner = runAuthorizedCommand,
): ToolDefinition<typeof authorizedCommandSchema> {
	return {
		name: "run_command",
		label: "Run authorized command",
		description: "Run one exact shell-free command from the supervisor's persisted allowlist.",
		parameters: authorizedCommandSchema,
		execute: async (_toolCallId, params, signal) => {
			try {
				const effectivePolicy = params.timeout
					? {
							...policy,
							commandTimeoutMs: Math.min(policy.commandTimeoutMs, Math.max(1000, params.timeout * 1000)),
						}
					: policy;
				assertCommandAuthorized(params.command, effectivePolicy);
				const evidence = await runner(params.command, cwd, effectivePolicy, signal);
				onEvidence(evidence);
				return {
					content: [
						{
							type: "text",
							text: `${evidence.stdout}${evidence.stderr ? `\nSTDERR:\n${evidence.stderr}` : ""}\nExit code: ${String(evidence.exitCode)}\nEvidence: ${evidence.id}`,
						},
					],
					details: evidence,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Denied: ${(error as Error).message}` }],
					details: { denied: true },
					endTurn: false,
				};
			}
		},
	};
}

type RoleTool =
	| ReturnType<typeof createReadTool>
	| ReturnType<typeof createGrepTool>
	| ReturnType<typeof createFindTool>
	| ReturnType<typeof createLsTool>
	| ReturnType<typeof createEditTool>
	| ReturnType<typeof createWriteTool>;

export function roleToolSurface(role: SessionRole, cwd: string): RoleTool[] {
	const readOnly: RoleTool[] = [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
	if (role !== "executor") return readOnly;
	return [...readOnly, createEditTool(cwd), createWriteTool(cwd)];
}
