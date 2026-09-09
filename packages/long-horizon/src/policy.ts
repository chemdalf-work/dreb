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
	CommandEvidence,
	CommandExecutionResult,
	DeniedCommandOutcome,
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

interface ParsedSubcommand {
	name: string;
	index: number;
}

function findPositional(
	argv: readonly string[],
	start: number,
	optionsWithValues: ReadonlySet<string>,
	attachedValuePrefixes: readonly string[],
): ParsedSubcommand | undefined {
	for (let index = start; index < argv.length; index++) {
		const token = argv[index];
		if (token === "--") {
			const name = argv[index + 1];
			return name ? { name: name.toLowerCase(), index: index + 1 } : undefined;
		}
		if (optionsWithValues.has(token)) {
			index++;
			continue;
		}
		if (attachedValuePrefixes.some((prefix) => token.startsWith(prefix))) continue;
		if (token.startsWith("-")) continue;
		return { name: token.toLowerCase(), index };
	}
	return undefined;
}

function findSubcommand(
	argv: readonly string[],
	executable: string,
	optionsWithValues: ReadonlySet<string>,
	attachedValuePrefixes: readonly string[],
): ParsedSubcommand | undefined {
	const executableIndex = argv.findIndex((token) => executableName(token) === executable);
	return executableIndex < 0
		? undefined
		: findPositional(argv, executableIndex + 1, optionsWithValues, attachedValuePrefixes);
}

const GIT_OPTIONS_WITH_VALUES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const GIT_ATTACHED_VALUE_PREFIXES = ["-C", "-c", "--git-dir=", "--work-tree=", "--namespace=", "--exec-path="];

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"annotate",
	"blame",
	"cat-file",
	"check-attr",
	"check-ignore",
	"check-mailmap",
	"check-ref-format",
	"describe",
	"diff",
	"diff-files",
	"diff-index",
	"diff-tree",
	"for-each-ref",
	"grep",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"merge-base",
	"name-rev",
	"range-diff",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-branch",
	"status",
	"version",
	"whatchanged",
]);

const GIT_LOCAL_OR_REMOTE_READ_SUBCOMMANDS = new Set([
	...GIT_READ_ONLY_SUBCOMMANDS,
	"add",
	"am",
	"apply",
	"archive",
	"bisect",
	"branch",
	"checkout",
	"cherry",
	"cherry-pick",
	"clean",
	"clone",
	"commit",
	"config",
	"fetch",
	"gc",
	"init",
	"maintenance",
	"merge",
	"mergetool",
	"mv",
	"notes",
	"pull",
	"rebase",
	"reflog",
	"remote",
	"reset",
	"restore",
	"revert",
	"rm",
	"stash",
	"submodule",
	"switch",
	"tag",
	"update-index",
	"update-ref",
	"worktree",
]);

function gitSubcommand(argv: readonly string[]): ParsedSubcommand | undefined {
	return findSubcommand(argv, "git", GIT_OPTIONS_WITH_VALUES, GIT_ATTACHED_VALUE_PREFIXES);
}

function isReadOnlyGitFamily(argv: readonly string[], subcommand: ParsedSubcommand): boolean {
	const args = argv.slice(subcommand.index + 1).map((token) => token.toLowerCase());
	if (subcommand.name === "stash") return args[0] === "list" || args[0] === "show";
	if (subcommand.name === "worktree") return args[0] === "list";
	if (subcommand.name === "remote")
		return args.length === 0 || args[0] === "-v" || args[0] === "show" || args[0] === "get-url";
	if (subcommand.name === "branch") {
		return args.length === 0 || args.some((token) => token === "--list" || token === "--show-current");
	}
	if (subcommand.name === "tag") {
		return (
			args.length === 0 ||
			args.some((token) =>
				["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"].includes(
					token.split("=")[0],
				),
			)
		);
	}
	return false;
}

function isDestructiveGit(argv: readonly string[]): boolean {
	const subcommand = gitSubcommand(argv);
	if (!subcommand) return false;
	if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand.name)) return false;
	return !isReadOnlyGitFamily(argv, subcommand);
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

const GH_READ_ONLY_ACTIONS = new Map<string, ReadonlySet<string>>([
	["alias", new Set(["list"])],
	["auth", new Set(["status", "token"])],
	["config", new Set(["get", "list"])],
	["extension", new Set(["list", "search"])],
	["issue", new Set(["list", "status", "view"])],
	["pr", new Set(["checks", "diff", "list", "status", "view"])],
	["release", new Set(["download", "list", "view"])],
	["repo", new Set(["list", "view"])],
	["run", new Set(["list", "view", "watch"])],
	["workflow", new Set(["list", "view"])],
]);
const GH_READ_ONLY_COMMANDS = new Set(["browse", "completion", "help", "search", "status", "version"]);
const GH_OPTIONS_WITH_VALUES = new Set(["-R", "--repo", "--hostname"]);
const GH_ATTACHED_VALUE_PREFIXES = ["-R", "--repo=", "--hostname="];

function ghApiMutatesRemoteState(args: readonly string[]): boolean {
	let method: string | undefined;
	let suppliesInput = false;
	for (let index = 0; index < args.length; index++) {
		const token = args[index];
		const lower = token.toLowerCase();
		if (lower === "-x" || lower === "--method") {
			method = args[index + 1]?.toLowerCase();
			index++;
			continue;
		}
		const attachedMethod = token.match(/^(?:-X|--method=)(.+)$/i)?.[1];
		if (attachedMethod) {
			method = attachedMethod.toLowerCase();
			continue;
		}
		if (/^(?:-f|-F)(?:.|$)|^--(?:raw-)?field(?:=|$)|^--input(?:=|$)/.test(token)) suppliesInput = true;
	}
	const effectiveMethod = method ?? (suppliesInput ? "post" : "get");
	return effectiveMethod !== "get" && effectiveMethod !== "head";
}

function ghCommand(argv: readonly string[]): { command: ParsedSubcommand; action?: ParsedSubcommand } | undefined {
	const command = findSubcommand(argv, "gh", GH_OPTIONS_WITH_VALUES, GH_ATTACHED_VALUE_PREFIXES);
	if (!command) return undefined;
	return {
		command,
		action: findPositional(argv, command.index + 1, GH_OPTIONS_WITH_VALUES, GH_ATTACHED_VALUE_PREFIXES),
	};
}

function accessesGhCredentials(argv: readonly string[]): boolean {
	const parsed = ghCommand(argv);
	return parsed?.command.name === "auth" && parsed.action?.name === "token";
}

function ghMutatesRemoteState(argv: readonly string[]): boolean {
	const parsed = ghCommand(argv);
	if (!parsed) return false;
	const args = argv.slice(parsed.command.index + 1);
	if (parsed.command.name === "api") return ghApiMutatesRemoteState(args);
	if (GH_READ_ONLY_COMMANDS.has(parsed.command.name)) return false;
	const allowedActions = GH_READ_ONLY_ACTIONS.get(parsed.command.name);
	if (!allowedActions) return true;
	return parsed.action === undefined || !allowedActions.has(parsed.action.name);
}

const GIT_LFS_LOCAL_OR_REMOTE_READ_ACTIONS = new Set(["checkout", "fetch", "install", "ls-files", "pull", "status"]);

function gitMutatesRemoteState(argv: readonly string[]): boolean {
	const subcommand = gitSubcommand(argv);
	if (!subcommand) return false;
	if (subcommand.name === "push" || subcommand.name === "send-pack") return true;
	if (subcommand.name === "lfs") {
		const action = findPositional(argv, subcommand.index + 1, new Set(), []);
		return action?.name === "push" || !GIT_LFS_LOCAL_OR_REMOTE_READ_ACTIONS.has(action?.name ?? "");
	}
	return !GIT_LOCAL_OR_REMOTE_READ_SUBCOMMANDS.has(subcommand.name);
}

const NODE_INLINE_EXECUTION_OPTIONS = new Set(["-e", "--eval", "-p", "--print"]);
const PYTHON_INLINE_EXECUTION_OPTIONS = new Set(["-c"]);
const RUBY_INLINE_EXECUTION_OPTIONS = new Set(["-e"]);
const PERL_INLINE_EXECUTION_OPTIONS = new Set(["-e"]);
const PHP_INLINE_EXECUTION_OPTIONS = new Set(["-r"]);
const OPAQUE_INLINE_EXECUTION_OPTIONS = new Map<string, ReadonlySet<string>>([
	["bash", new Set(["-c"])],
	["bun", NODE_INLINE_EXECUTION_OPTIONS],
	["dash", new Set(["-c"])],
	["deno", new Set(["eval"])],
	["fish", new Set(["-c"])],
	["node", NODE_INLINE_EXECUTION_OPTIONS],
	["nodejs", NODE_INLINE_EXECUTION_OPTIONS],
	["perl", PERL_INLINE_EXECUTION_OPTIONS],
	["php", PHP_INLINE_EXECUTION_OPTIONS],
	["powershell", new Set(["-command", "-encodedcommand"])],
	["pwsh", new Set(["-command", "-encodedcommand"])],
	["python", PYTHON_INLINE_EXECUTION_OPTIONS],
	["python3", PYTHON_INLINE_EXECUTION_OPTIONS],
	["ruby", RUBY_INLINE_EXECUTION_OPTIONS],
	["sh", new Set(["-c"])],
	["zsh", new Set(["-c"])],
]);

function inlineExecutionOptions(executable: string): ReadonlySet<string> | undefined {
	const exact = OPAQUE_INLINE_EXECUTION_OPTIONS.get(executable);
	if (exact) return exact;
	if (/^python\d+(?:\.\d+)*$/.test(executable)) return PYTHON_INLINE_EXECUTION_OPTIONS;
	if (/^ruby\d+(?:\.\d+)*$/.test(executable)) return RUBY_INLINE_EXECUTION_OPTIONS;
	if (/^perl\d+(?:\.\d+)*$/.test(executable)) return PERL_INLINE_EXECUTION_OPTIONS;
	if (/^php\d+(?:\.\d+)*$/.test(executable)) return PHP_INLINE_EXECUTION_OPTIONS;
	return undefined;
}

function executesOpaqueInlineCode(argv: readonly string[]): boolean {
	for (let index = 0; index < argv.length; index++) {
		const options = inlineExecutionOptions(executableName(argv[index]));
		if (!options) continue;
		for (const token of argv.slice(index + 1)) {
			const lower = token.toLowerCase();
			if (options.has(lower)) return true;
			if ([...options].some((option) => option.startsWith("--") && lower.startsWith(`${option}=`))) return true;
			if ([...options].some((option) => option.length === 2 && lower.startsWith(option) && lower.length > 2))
				return true;
		}
	}
	return false;
}

function mutatesRemoteState(argv: readonly string[]): boolean {
	if (isRelease(argv) || isDeployment(argv)) return true;
	if (argv.some((token) => executableName(token) === "git") && gitMutatesRemoteState(argv)) return true;
	if (argv.some((token) => executableName(token) === "gh") && ghMutatesRemoteState(argv)) return true;
	if (executesOpaqueInlineCode(argv)) return true;
	if (argv.some((token) => ["rsync", "scp", "sftp", "ssh"].includes(executableName(token)))) return true;
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
	if (!policy.allowCredentials && (argv.some(isSensitiveCredentialPath) || accessesGhCredentials(argv))) {
		throw new Error("credential access denied");
	}
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

export function isCommandEvidence(result: CommandExecutionResult): result is CommandEvidence {
	return !("outcome" in result);
}

export function isDeniedCommandOutcome(result: CommandExecutionResult): result is DeniedCommandOutcome {
	return "outcome" in result && result.outcome === "denied";
}

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
				const timestamp = new Date().toISOString();
				const denied: DeniedCommandOutcome = {
					outcome: "denied",
					id: randomUUID(),
					command: params.command,
					exitCode: null,
					stdout: "",
					stderr: "",
					startedAt: timestamp,
					completedAt: timestamp,
					reason: error instanceof Error ? error.message : String(error),
				};
				onEvidence(denied);
				return {
					content: [{ type: "text", text: `Denied: ${denied.reason}` }],
					details: denied,
					isError: true,
					endTurn: true,
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
