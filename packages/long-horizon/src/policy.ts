import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import type {
	AuthorizationPolicy,
	CommandExecutionResult,
	SessionRole,
	UncertainCommandOutcome,
	WorkspaceContext,
} from "./types.js";

const MUTATING_HTTP_METHODS = new Set(["post", "put", "patch", "delete"]);
const CREDENTIAL_COMPONENT = /(?:^|[._-])(?:credentials?|secrets?)(?:$|[._-])/i;
const OPENSSH_PRIVATE_KEY = /(?:^|[._-])id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._-])/i;
const CREDENTIAL_EXTENSION = /\.(?:pem|key|p12|pfx)$/i;

/** Match sensitive credential filenames and path segments without accepting ordinary substrings. */
function isSensitiveCredentialPath(value: string): boolean {
	for (const attachedValue of value.split("=")) {
		for (const segment of attachedValue.split(/[\\/]+/)) {
			if (!segment) continue;
			if (/^\.env(?:$|[.-])/i.test(segment)) return true;
			if (CREDENTIAL_COMPONENT.test(segment)) return true;
			if (OPENSSH_PRIVATE_KEY.test(segment)) return true;
			if (CREDENTIAL_EXTENSION.test(segment)) return true;
		}
	}
	return false;
}

function executableName(token: string): string {
	return token.split(/[\\/]/).at(-1)?.toLowerCase() ?? token.toLowerCase();
}

/** Find an ordered command/subcommand sequence in parsed argv, ignoring interleaved global options. */
function hasCommandSequence(argv: readonly string[], executable: string, sequence: readonly string[]): boolean {
	for (let start = 0; start < argv.length; start++) {
		if (executableName(argv[start]) !== executable) continue;
		let next = start + 1;
		for (const expected of sequence) {
			next = argv.findIndex((token, index) => index >= next && token.toLowerCase() === expected);
			if (next < 0) break;
			next++;
		}
		if (next > start + sequence.length) return true;
	}
	return false;
}

function hasGitSubcommandOption(
	argv: readonly string[],
	subcommand: string,
	option: (token: string) => boolean,
): boolean {
	const gitIndex = argv.findIndex((token) => executableName(token) === "git");
	if (gitIndex < 0) return false;
	const subcommandIndex = argv.findIndex((token, index) => index > gitIndex && token.toLowerCase() === subcommand);
	return subcommandIndex >= 0 && argv.slice(subcommandIndex + 1).some(option);
}

function isDestructiveGit(argv: readonly string[]): boolean {
	return (
		hasCommandSequence(argv, "git", ["push"]) ||
		hasCommandSequence(argv, "git", ["clean"]) ||
		hasCommandSequence(argv, "git", ["reset"]) ||
		hasCommandSequence(argv, "git", ["restore"]) ||
		hasCommandSequence(argv, "git", ["checkout"]) ||
		hasGitSubcommandOption(argv, "switch", (token) => {
			const lower = token.toLowerCase();
			return (
				token === "-f" ||
				token === "-C" ||
				token.startsWith("-C") ||
				lower === "--force" ||
				lower === "--discard-changes" ||
				lower === "--force-create" ||
				lower.startsWith("--force-create=") ||
				lower === "--orphan" ||
				lower.startsWith("--orphan=")
			);
		}) ||
		hasGitSubcommandOption(argv, "branch", (token) => {
			const lower = token.toLowerCase();
			return ["-d", "-D", "-f", "-M"].includes(token) || lower === "--delete" || lower === "--force";
		}) ||
		hasGitSubcommandOption(argv, "tag", (token) => {
			const lower = token.toLowerCase();
			return token === "-d" || token === "-f" || lower === "--delete" || lower === "--force";
		})
	);
}

function isRelease(argv: readonly string[]): boolean {
	return (
		hasCommandSequence(argv, "npm", ["publish"]) ||
		hasCommandSequence(argv, "pnpm", ["publish"]) ||
		hasCommandSequence(argv, "yarn", ["npm", "publish"]) ||
		hasCommandSequence(argv, "gh", ["release"])
	);
}

function isDeployment(argv: readonly string[]): boolean {
	return (
		hasCommandSequence(argv, "kubectl", ["apply"]) ||
		hasCommandSequence(argv, "kubectl", ["delete"]) ||
		hasCommandSequence(argv, "helm", ["install"]) ||
		hasCommandSequence(argv, "helm", ["upgrade"]) ||
		hasCommandSequence(argv, "helm", ["uninstall"]) ||
		hasCommandSequence(argv, "terraform", ["apply"]) ||
		hasCommandSequence(argv, "terraform", ["destroy"]) ||
		hasCommandSequence(argv, "vercel", ["deploy"])
	);
}

function mutatesRemoteState(argv: readonly string[]): boolean {
	const ghMutation = ["pr", "issue"].some((resource) =>
		["create", "edit", "close", "merge", "comment"].some((action) =>
			hasCommandSequence(argv, "gh", [resource, action]),
		),
	);
	if (ghMutation) return true;
	const curlIndex = argv.findIndex((token) => executableName(token) === "curl");
	if (curlIndex < 0) return false;
	return argv.slice(curlIndex + 1).some((token, index, tail) => {
		const lower = token.toLowerCase();
		if (MUTATING_HTTP_METHODS.has(lower)) return true;
		if (/^-x(?:post|put|patch|delete)$/i.test(token) || /^--request=(?:post|put|patch|delete)$/i.test(token))
			return true;
		if ((lower === "-x" || lower === "--request") && MUTATING_HTTP_METHODS.has(tail[index + 1]?.toLowerCase())) {
			return true;
		}
		return /^(?:-d(?:.|$)|-F(?:.|$)|-T(?:.|$)|--data(?:-|=|$)|--form(?:-|=|$)|--json(?:=|$)|--upload-file(?:=|$))/.test(
			token,
		);
	});
}

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
	if (!policy.allowDestructiveGit && isDestructiveGit(argv)) throw new Error("destructive git command denied");
	if (!policy.allowRelease && isRelease(argv)) throw new Error("release command denied");
	if (!policy.allowDeploy && isDeployment(argv)) throw new Error("deployment command denied");
	if (!policy.allowCredentials && argv.some(isSensitiveCredentialPath)) throw new Error("credential access denied");
	if (!policy.allowRemoteState && mutatesRemoteState(argv)) throw new Error("remote-state mutation denied");
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
	if (signal?.aborted) {
		return Promise.resolve({ exitCode: null, stdout: "", stderr: "", termination: "aborted" });
	}
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

function gitOutputPreview(cwd: string, args: string[], maxBytes: number): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("git", args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let capturedBytes = 0;
		let truncated = false;
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			if (capturedBytes < maxBytes) {
				const remaining = maxBytes - capturedBytes;
				const captured = chunk.subarray(0, remaining);
				chunks.push(captured);
				capturedBytes += captured.length;
			}
			if (capturedBytes >= maxBytes && (chunk.length > 0 || chunks.length > 0)) {
				truncated = true;
				child.kill("SIGTERM");
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr = bounded(stderr + String(chunk), 64 * 1024);
		});
		child.on("error", reject);
		child.on("close", (exitCode) => {
			if (exitCode !== 0 && !truncated) {
				reject(new Error(`git ${args[0]} failed (${String(exitCode)}): ${stderr.trim()}`));
				return;
			}
			const preview = Buffer.concat(chunks).toString("utf8");
			resolvePromise(truncated ? `${preview}\n[truncated at ${maxBytes} bytes]` : preview);
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

export async function getWorkspaceContext(cwd: string, maxSectionBytes = 32 * 1024): Promise<WorkspaceContext> {
	if (!Number.isSafeInteger(maxSectionBytes) || maxSectionBytes <= 0) {
		throw new Error("workspace context limit must be a positive safe integer");
	}
	const root = resolve(cwd);
	const [workspaceIdentity, status, diff] = await Promise.all([
		getWorkspaceIdentity(root),
		gitOutputPreview(root, ["status", "--short", "--branch", "--untracked-files=all"], maxSectionBytes),
		gitOutputPreview(root, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"], maxSectionBytes),
	]);
	return { workspaceIdentity, status, diff };
}

export type CommandRunner = (
	command: string,
	cwd: string,
	policy: AuthorizationPolicy,
	signal?: AbortSignal,
) => Promise<CommandExecutionResult>;

export function isUncertainCommandOutcome(result: CommandExecutionResult): result is UncertainCommandOutcome {
	return "outcome" in result && result.outcome === "uncertain";
}

export const runAuthorizedCommand: CommandRunner = async (command, cwd, policy, signal) => {
	assertCommandAuthorized(command, policy);
	const [executable, ...args] = parseCommand(command);
	const startedAt = new Date().toISOString();
	const result = await executeProcess(executable, args, cwd, policy.commandTimeoutMs, policy.maxOutputBytes, signal);
	const completedAt = new Date().toISOString();
	try {
		return {
			id: randomUUID(),
			command,
			...result,
			startedAt,
			completedAt,
			workspaceIdentity: await getWorkspaceIdentity(cwd),
		};
	} catch (error) {
		return {
			outcome: "uncertain",
			id: randomUUID(),
			command,
			...result,
			startedAt,
			completedAt,
			reconciliationError: error instanceof Error ? error.message : String(error),
		};
	}
};

const authorizedCommandSchema = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) });

export function createAuthorizedCommandTool(
	cwd: string,
	policy: AuthorizationPolicy,
	onEvidence: (evidence: CommandExecutionResult) => void,
	runner: CommandRunner = runAuthorizedCommand,
): ToolDefinition<typeof authorizedCommandSchema> {
	return {
		name: "run_command",
		label: "Run authorized command",
		description: "Run one exact shell-free command from the supervisor's persisted allowlist.",
		parameters: authorizedCommandSchema,
		execute: async (_toolCallId, params, signal) => {
			const effectivePolicy = params.timeout
				? {
						...policy,
						commandTimeoutMs: Math.min(policy.commandTimeoutMs, Math.max(1000, params.timeout * 1000)),
					}
				: policy;
			try {
				assertCommandAuthorized(params.command, effectivePolicy);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Denied: ${(error as Error).message}` }],
					details: { denied: true },
					endTurn: false,
				};
			}
			const evidence = await runner(params.command, cwd, effectivePolicy, signal);
			onEvidence(evidence);
			if (isUncertainCommandOutcome(evidence)) {
				return {
					content: [
						{
							type: "text",
							text: `Command outcome requires reconciliation: ${evidence.reconciliationError}`,
						},
					],
					details: evidence,
					isError: true,
					endTurn: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `${evidence.stdout}${evidence.stderr ? `\nSTDERR:\n${evidence.stderr}` : ""}\nExit code: ${String(evidence.exitCode)}\nEvidence: ${evidence.id}`,
					},
				],
				details: evidence,
			};
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

function isContained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function normalizeToolPath(requestedPath: string): string {
	let normalized = requestedPath;
	if (
		normalized.length >= 2 &&
		((normalized.startsWith('"') && normalized.endsWith('"')) ||
			(normalized.startsWith("'") && normalized.endsWith("'")))
	) {
		normalized = normalized.slice(1, -1);
	}
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	normalized = normalized.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/")) return `${homedir()}${normalized.slice(1)}`;
	return normalized;
}

function assertResolvedWorkspacePath(cwd: string, candidate: string): string {
	const lexicalRoot = resolve(cwd);
	if (!isContained(lexicalRoot, candidate)) throw new Error("file tool path escapes configured workspace");

	const realRoot = realpathSync(lexicalRoot);
	let existing = candidate;
	while (true) {
		try {
			lstatSync(existing);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(existing);
			if (parent === existing) throw new Error("file tool path has no existing workspace ancestor");
			existing = parent;
		}
	}
	let realExisting: string;
	try {
		realExisting = realpathSync(existing);
	} catch {
		throw new Error("file tool path contains an unresolved symbolic link");
	}
	if (!isContained(realRoot, realExisting)) throw new Error("file tool path escapes configured workspace via symlink");
	return realExisting;
}

/** Validate both lexical traversal and existing symlink ancestors before a stock file tool runs. */
export function assertWorkspacePath(cwd: string, requestedPath: string): void {
	assertResolvedWorkspacePath(cwd, resolve(cwd, normalizeToolPath(requestedPath || ".")));
}

function gitControlPaths(cwd: string): string[] {
	const dotGit = resolve(cwd, ".git");
	const paths = [dotGit];
	if (!existsSync(dotGit) || !lstatSync(dotGit).isFile()) return paths;
	const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
	if (!match?.[1]) throw new Error("Git control file does not name a git directory");
	const gitDir = resolve(dirname(dotGit), match[1].trim());
	paths.push(gitDir);
	const commonDirFile = join(gitDir, "commondir");
	if (existsSync(commonDirFile)) {
		const commonDir = readFileSync(commonDirFile, "utf8").trim();
		if (!commonDir) throw new Error("Git common-dir file is empty");
		paths.push(resolve(gitDir, commonDir));
	}
	return paths;
}

function assertMutableWorkspacePath(cwd: string, requestedPath: string, protectedPaths: readonly string[]): void {
	const candidate = resolve(cwd, normalizeToolPath(requestedPath || "."));
	const realCandidate = assertResolvedWorkspacePath(cwd, candidate);
	if (existsSync(candidate)) {
		const candidateStat = lstatSync(candidate);
		if (candidateStat.isFile() && candidateStat.nlink > 1) {
			throw new Error("file tool mutation targets a protected control-plane path through a hard link");
		}
	}
	for (const path of protectedPaths) {
		const protectedPath = resolve(cwd, path);
		if (isContained(protectedPath, candidate))
			throw new Error("file tool mutation targets a protected control-plane path");
		if (!existsSync(protectedPath)) continue;
		let realProtectedPath: string;
		try {
			realProtectedPath = realpathSync(protectedPath);
		} catch {
			throw new Error("protected control-plane path cannot be resolved");
		}
		if (isContained(realProtectedPath, realCandidate)) {
			throw new Error("file tool mutation targets a protected control-plane path");
		}
	}
}

function assertReadWorkspacePath(cwd: string, requestedPath: string): void {
	const requested = resolve(cwd, normalizeToolPath(requestedPath));
	const nfd = requested.normalize("NFD");
	const candidates = [
		requested,
		requested.replace(/ (AM|PM)\./g, "\u202F$1."),
		nfd,
		requested.replace(/'/g, "\u2019"),
		nfd.replace(/'/g, "\u2019"),
	];
	assertResolvedWorkspacePath(cwd, candidates.find((candidate) => existsSync(candidate)) ?? requested);
}

export interface RoleToolSurfaceOptions {
	protectedMutationPaths?: readonly string[];
	allowCredentials?: boolean;
}

function assertCredentialAccessAllowed(requestedPath: string, allowCredentials: boolean): void {
	if (!allowCredentials && isSensitiveCredentialPath(normalizeToolPath(requestedPath))) {
		throw new Error("credential access denied");
	}
}

function confineRoleTool<T extends RoleTool>(
	tool: T,
	cwd: string,
	{ protectedMutationPaths = [], allowCredentials = false }: RoleToolSurfaceOptions = {},
): T {
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		execute: (async (toolCallId: string, params: { path?: string }, signal?: AbortSignal, onUpdate?: unknown) => {
			if (tool.name === "read") {
				assertCredentialAccessAllowed(params.path ?? ".", allowCredentials);
				assertReadWorkspacePath(cwd, params.path ?? ".");
			} else if (tool.name === "grep") {
				assertCredentialAccessAllowed(params.path ?? ".", allowCredentials);
				assertWorkspacePath(cwd, params.path ?? ".");
			} else if (tool.name === "edit" || tool.name === "write") {
				assertCredentialAccessAllowed(params.path ?? ".", allowCredentials);
				assertMutableWorkspacePath(cwd, params.path ?? ".", protectedMutationPaths);
			} else assertWorkspacePath(cwd, params.path ?? ".");
			return execute(toolCallId, params as never, signal, onUpdate as never);
		}) as T["execute"],
	};
}

export function roleToolSurface(role: SessionRole, cwd: string, options: RoleToolSurfaceOptions = {}): RoleTool[] {
	const { protectedMutationPaths = [] } = options;
	const readOnly: RoleTool[] = [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)].map(
		(tool) => confineRoleTool(tool, cwd, options),
	);
	if (role !== "executor") return readOnly;
	const protectedPaths = [...gitControlPaths(cwd), ...protectedMutationPaths];
	return [
		...readOnly,
		confineRoleTool(createEditTool(cwd), cwd, { ...options, protectedMutationPaths: protectedPaths }),
		confineRoleTool(createWriteTool(cwd), cwd, { ...options, protectedMutationPaths: protectedPaths }),
	];
}
