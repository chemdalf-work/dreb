import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseRunConfig } from "./config.js";
import { validateHandoffArtifact } from "./reports.js";
import { applyJournalRecord, replayJournal } from "./state-machine.js";
import type {
	CapturedFailureEvidence,
	HandoffArtifact,
	JournalEventData,
	JournalRecord,
	LongHorizonRunConfig,
	RunState,
	UncertainCommandOutcome,
} from "./types.js";

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
		.join(",")}}`;
}

export function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

function recordHash(record: Omit<JournalRecord, "hash">): string {
	return digest(record);
}

function contentDigest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

const RUN_PHASES = new Set([
	"created",
	"planning",
	"executing",
	"wrapping",
	"handoff",
	"blocked",
	"paused",
	"completed",
	"failed",
	"aborted",
]);
const SESSION_ROLES = new Set(["planner", "executor", "advisor", "verifier"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CONTROL_ACTIONS = new Set(["pause", "resume", "abort"]);
const EFFECT_KINDS = new Set(["session", "plan", "round", "advice", "handoff", "acceptance", "final-verification"]);
const REPORT_STATUSES = new Set(["progress", "complete", "blocked", "verification-failed"]);

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	name: string,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	const unknown = Object.keys(value).filter((key) => value[key] !== undefined && !allowed.has(key));
	if (unknown.length > 0) throw new Error(`${name} contains unknown fields: ${unknown.join(", ")}`);
	const missing = required.filter((key) => !Object.hasOwn(value, key));
	if (missing.length > 0) throw new Error(`${name} is missing fields: ${missing.join(", ")}`);
}

function nonEmptyString(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}

function optionalString(value: unknown, name: string): void {
	if (value !== undefined && typeof value !== "string") throw new Error(`${name} must be a string`);
}

function artifactDigest(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} is invalid`);
}

function finiteNumber(value: unknown, name: string, minimum = 0): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		throw new Error(`${name} must be a finite number greater than or equal to ${minimum}`);
	}
}

function safeInteger(value: unknown, name: string, minimum = 0): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
	}
}

function enumString(value: unknown, name: string, allowed: ReadonlySet<string>): asserts value is string {
	if (typeof value !== "string" || !allowed.has(value)) throw new Error(`${name} is invalid`);
}

function validTimestamp(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
		throw new Error(`${name} must be a valid timestamp`);
	}
}

function stringArray(value: unknown, name: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`${name} must be an array of non-empty strings`);
	}
}

function validateSessionReference(value: unknown, name: string): void {
	const session = object(value, name);
	exactKeys(
		session,
		name,
		["id", "role", "file", "provider", "modelId", "thinkingLevel", "createdAt"],
		["parentFile"],
	);
	nonEmptyString(session.id, `${name}.id`);
	enumString(session.role, `${name}.role`, SESSION_ROLES);
	nonEmptyString(session.file, `${name}.file`);
	optionalString(session.parentFile, `${name}.parentFile`);
	nonEmptyString(session.provider, `${name}.provider`);
	nonEmptyString(session.modelId, `${name}.modelId`);
	enumString(session.thinkingLevel, `${name}.thinkingLevel`, THINKING_LEVELS);
	validTimestamp(session.createdAt, `${name}.createdAt`);
}

function validateFailure(value: unknown, name: string): void {
	const failure = object(value, name);
	exactKeys(failure, name, ["operation", "diagnostic"], ["command", "exitCode"]);
	nonEmptyString(failure.operation, `${name}.operation`);
	nonEmptyString(failure.diagnostic, `${name}.diagnostic`);
	optionalString(failure.command, `${name}.command`);
	if (
		failure.exitCode !== undefined &&
		failure.exitCode !== null &&
		(typeof failure.exitCode !== "number" || !Number.isSafeInteger(failure.exitCode))
	) {
		throw new Error(`${name}.exitCode must be an integer or null`);
	}
}

function validateCapturedFailureEvidence(value: unknown, name: string): asserts value is CapturedFailureEvidence {
	const captured = object(value, name);
	exactKeys(captured, name, ["source", "evidence"]);
	if (captured.source === "command") {
		validateCommandEvidence(captured.evidence, `${name}.evidence`);
		return;
	}
	if (captured.source === "tool") {
		validateToolEvidence(captured.evidence, `${name}.evidence`);
		return;
	}
	throw new Error(`${name}.source is invalid`);
}

function validateTerraReport(value: unknown, name: string): asserts value is import("./types.js").TerraRoundReport {
	const report = object(value, name);
	exactKeys(
		report,
		name,
		["schemaVersion", "status", "workUnitId", "strategyId", "progress", "evidenceIds", "handoffReady", "nextAction"],
		["failure"],
	);
	if (report.schemaVersion !== 1) throw new Error(`${name}.schemaVersion is unsupported`);
	enumString(report.status, `${name}.status`, REPORT_STATUSES);
	nonEmptyString(report.workUnitId, `${name}.workUnitId`);
	nonEmptyString(report.strategyId, `${name}.strategyId`);
	nonEmptyString(report.progress, `${name}.progress`);
	stringArray(report.evidenceIds, `${name}.evidenceIds`);
	if (typeof report.handoffReady !== "boolean") throw new Error(`${name}.handoffReady must be a boolean`);
	nonEmptyString(report.nextAction, `${name}.nextAction`);
	if (report.failure !== undefined) validateFailure(report.failure, `${name}.failure`);
	if (report.status === "verification-failed" && report.failure === undefined) {
		throw new Error(`${name}.failure is required`);
	}
	if (report.status !== "verification-failed" && report.failure !== undefined) {
		throw new Error(`${name}.failure is only valid for verification-failed reports`);
	}
}

function validateCommandEvidence(value: unknown, name: string): void {
	const evidence = object(value, name);
	exactKeys(
		evidence,
		name,
		["id", "command", "exitCode", "stdout", "stderr", "startedAt", "completedAt", "workspaceIdentity"],
		["termination"],
	);
	nonEmptyString(evidence.id, `${name}.id`);
	nonEmptyString(evidence.command, `${name}.command`);
	if (
		evidence.exitCode !== null &&
		(typeof evidence.exitCode !== "number" || !Number.isSafeInteger(evidence.exitCode))
	) {
		throw new Error(`${name}.exitCode must be an integer or null`);
	}
	if (typeof evidence.stdout !== "string") throw new Error(`${name}.stdout must be a string`);
	if (typeof evidence.stderr !== "string") throw new Error(`${name}.stderr must be a string`);
	validTimestamp(evidence.startedAt, `${name}.startedAt`);
	validTimestamp(evidence.completedAt, `${name}.completedAt`);
	nonEmptyString(evidence.workspaceIdentity, `${name}.workspaceIdentity`);
	if (evidence.termination !== undefined && evidence.termination !== "timeout" && evidence.termination !== "aborted") {
		throw new Error(`${name}.termination is invalid`);
	}
}

function validateUncertainCommandOutcome(value: unknown, name: string): asserts value is UncertainCommandOutcome {
	const evidence = object(value, name);
	exactKeys(
		evidence,
		name,
		["outcome", "id", "command", "exitCode", "stdout", "stderr", "startedAt", "completedAt", "reconciliationError"],
		["termination"],
	);
	if (evidence.outcome !== "uncertain") throw new Error(`${name}.outcome is invalid`);
	nonEmptyString(evidence.id, `${name}.id`);
	nonEmptyString(evidence.command, `${name}.command`);
	if (
		evidence.exitCode !== null &&
		(typeof evidence.exitCode !== "number" || !Number.isSafeInteger(evidence.exitCode))
	) {
		throw new Error(`${name}.exitCode must be an integer or null`);
	}
	if (typeof evidence.stdout !== "string") throw new Error(`${name}.stdout must be a string`);
	if (typeof evidence.stderr !== "string") throw new Error(`${name}.stderr must be a string`);
	validTimestamp(evidence.startedAt, `${name}.startedAt`);
	validTimestamp(evidence.completedAt, `${name}.completedAt`);
	nonEmptyString(evidence.reconciliationError, `${name}.reconciliationError`);
	if (evidence.termination !== undefined && evidence.termination !== "timeout" && evidence.termination !== "aborted") {
		throw new Error(`${name}.termination is invalid`);
	}
}

function validateToolEvidence(value: unknown, name: string): void {
	const evidence = object(value, name);
	exactKeys(evidence, name, ["id", "toolName", "startedAt", "completedAt", "args", "result", "isError"]);
	nonEmptyString(evidence.id, `${name}.id`);
	nonEmptyString(evidence.toolName, `${name}.toolName`);
	validTimestamp(evidence.startedAt, `${name}.startedAt`);
	validTimestamp(evidence.completedAt, `${name}.completedAt`);
	if (typeof evidence.isError !== "boolean") throw new Error(`${name}.isError must be a boolean`);
}

function validateJournalEvent(value: unknown): JournalEventData {
	const event = object(value, "journal event");
	if (typeof event.type !== "string") throw new Error("journal event.type must be a string");
	const name = `journal event ${event.type}`;
	switch (event.type) {
		case "run_created":
			exactKeys(event, name, ["type", "configDigest"]);
			nonEmptyString(event.configDigest, `${name}.configDigest`);
			break;
		case "phase_changed":
			exactKeys(event, name, ["type", "from", "to", "reason"]);
			enumString(event.from, `${name}.from`, RUN_PHASES);
			enumString(event.to, `${name}.to`, RUN_PHASES);
			nonEmptyString(event.reason, `${name}.reason`);
			break;
		case "control_requested":
			exactKeys(event, name, ["type", "action"], ["reason"]);
			enumString(event.action, `${name}.action`, CONTROL_ACTIONS);
			optionalString(event.reason, `${name}.reason`);
			break;
		case "session_registered":
			exactKeys(event, name, ["type", "session"]);
			validateSessionReference(event.session, `${name}.session`);
			break;
		case "effect_intent":
			exactKeys(event, name, ["type", "effectId", "kind"], ["sessionId"]);
			nonEmptyString(event.effectId, `${name}.effectId`);
			enumString(event.kind, `${name}.kind`, EFFECT_KINDS);
			optionalString(event.sessionId, `${name}.sessionId`);
			if (event.kind === "handoff" && event.sessionId === undefined) {
				throw new Error(`${name}.sessionId is required for a handoff intent`);
			}
			break;
		case "effect_completed":
			exactKeys(event, name, ["type", "effectId", "kind"], ["artifact", "artifactDigest"]);
			nonEmptyString(event.effectId, `${name}.effectId`);
			enumString(event.kind, `${name}.kind`, EFFECT_KINDS);
			optionalString(event.artifact, `${name}.artifact`);
			if ((event.artifact === undefined) !== (event.artifactDigest === undefined)) {
				throw new Error(`${name}.artifact and artifactDigest must be recorded together`);
			}
			if (event.kind === "handoff" && event.artifact === undefined) {
				throw new Error(`${name}.artifact and artifactDigest are required for a handoff completion`);
			}
			if (event.artifactDigest !== undefined) artifactDigest(event.artifactDigest, `${name}.artifactDigest`);
			break;
		case "effect_abandoned":
			exactKeys(event, name, ["type", "effectId", "kind", "reason"]);
			nonEmptyString(event.effectId, `${name}.effectId`);
			enumString(event.kind, `${name}.kind`, EFFECT_KINDS);
			nonEmptyString(event.reason, `${name}.reason`);
			break;
		case "command_outcome_uncertain":
			exactKeys(event, name, ["type", "effectId", "evidence"]);
			nonEmptyString(event.effectId, `${name}.effectId`);
			validateUncertainCommandOutcome(event.evidence, `${name}.evidence`);
			break;
		case "round_completed":
			exactKeys(
				event,
				name,
				["type", "effectId", "artifact", "artifactDigest", "round", "report", "verificationSucceeded"],
				["failureSignature", "failureEvidence"],
			);
			nonEmptyString(event.effectId, `${name}.effectId`);
			nonEmptyString(event.artifact, `${name}.artifact`);
			artifactDigest(event.artifactDigest, `${name}.artifactDigest`);
			safeInteger(event.round, `${name}.round`, 1);
			validateTerraReport(event.report, `${name}.report`);
			optionalString(event.failureSignature, `${name}.failureSignature`);
			if (event.failureEvidence !== undefined) {
				validateCapturedFailureEvidence(event.failureEvidence, `${name}.failureEvidence`);
			}
			if (event.report.status === "verification-failed") {
				if (event.failureSignature === undefined || event.failureEvidence === undefined) {
					throw new Error(`${name} requires a failure signature and captured evidence`);
				}
			} else if (event.failureSignature !== undefined || event.failureEvidence !== undefined) {
				throw new Error(`${name} failure details require verification-failed status`);
			}
			if (typeof event.verificationSucceeded !== "boolean") {
				throw new Error(`${name}.verificationSucceeded must be a boolean`);
			}
			break;
		case "usage_recorded":
			exactKeys(event, name, ["type", "role", "tokens", "costUsd"]);
			enumString(event.role, `${name}.role`, SESSION_ROLES);
			finiteNumber(event.tokens, `${name}.tokens`);
			finiteNumber(event.costUsd, `${name}.costUsd`);
			break;
		case "context_observed":
			exactKeys(event, name, ["type", "sessionId", "tokens", "contextWindow"]);
			nonEmptyString(event.sessionId, `${name}.sessionId`);
			finiteNumber(event.tokens, `${name}.tokens`);
			finiteNumber(event.contextWindow, `${name}.contextWindow`, Number.MIN_VALUE);
			break;
		case "failure_recorded":
			exactKeys(event, name, ["type", "workUnitId", "strategyId", "signature"]);
			nonEmptyString(event.workUnitId, `${name}.workUnitId`);
			nonEmptyString(event.strategyId, `${name}.strategyId`);
			nonEmptyString(event.signature, `${name}.signature`);
			break;
		case "failure_reset":
			exactKeys(event, name, ["type", "workUnitId", "reason"]);
			nonEmptyString(event.workUnitId, `${name}.workUnitId`);
			enumString(event.reason, `${name}.reason`, new Set(["verification", "strategy_changed"]));
			break;
		case "escalation_completed":
			exactKeys(event, name, ["type", "workUnitId", "signature", "adviceArtifact", "adviceArtifactDigest"]);
			nonEmptyString(event.workUnitId, `${name}.workUnitId`);
			nonEmptyString(event.signature, `${name}.signature`);
			nonEmptyString(event.adviceArtifact, `${name}.adviceArtifact`);
			artifactDigest(event.adviceArtifactDigest, `${name}.adviceArtifactDigest`);
			break;
		case "acceptance_recorded": {
			exactKeys(event, name, ["type", "evidence"], ["effectId", "round", "commandIndex"]);
			validateCommandEvidence(event.evidence, `${name}.evidence`);
			const checkpointFields = [event.effectId, event.round, event.commandIndex];
			if (
				checkpointFields.some((value) => value !== undefined) &&
				checkpointFields.some((value) => value === undefined)
			) {
				throw new Error(`${name} checkpoint metadata must be complete`);
			}
			if (event.effectId !== undefined) nonEmptyString(event.effectId, `${name}.effectId`);
			if (event.round !== undefined) safeInteger(event.round, `${name}.round`, 1);
			if (event.commandIndex !== undefined) safeInteger(event.commandIndex, `${name}.commandIndex`);
			break;
		}
		case "acceptance_completed":
			exactKeys(
				event,
				name,
				["type", "effectId", "artifact", "artifactDigest", "round", "status", "evidenceIds"],
				["workspaceIdentity"],
			);
			nonEmptyString(event.effectId, `${name}.effectId`);
			nonEmptyString(event.artifact, `${name}.artifact`);
			artifactDigest(event.artifactDigest, `${name}.artifactDigest`);
			safeInteger(event.round, `${name}.round`, 1);
			enumString(event.status, `${name}.status`, new Set(["partial", "passed", "failed"]));
			stringArray(event.evidenceIds, `${name}.evidenceIds`);
			optionalString(event.workspaceIdentity, `${name}.workspaceIdentity`);
			break;
		case "final_verification_recorded":
			exactKeys(event, name, ["type", "round", "accepted", "artifact", "artifactDigest"]);
			safeInteger(event.round, `${name}.round`, 1);
			if (typeof event.accepted !== "boolean") throw new Error(`${name}.accepted must be a boolean`);
			nonEmptyString(event.artifact, `${name}.artifact`);
			artifactDigest(event.artifactDigest, `${name}.artifactDigest`);
			break;
		case "acceptance_reset":
			exactKeys(event, name, ["type", "round", "stage", "reason"], ["retryFrom"]);
			safeInteger(event.round, `${name}.round`, 1);
			enumString(event.stage, `${name}.stage`, new Set(["commands", "verification"]));
			nonEmptyString(event.reason, `${name}.reason`);
			if (event.stage === "commands") safeInteger(event.retryFrom, `${name}.retryFrom`);
			else if (event.retryFrom !== undefined) throw new Error(`${name}.retryFrom requires command reset`);
			break;
		case "blocked":
			exactKeys(event, name, ["type", "reason"]);
			nonEmptyString(event.reason, `${name}.reason`);
			break;
		case "terminal":
			exactKeys(event, name, ["type", "phase", "reason"]);
			enumString(event.phase, `${name}.phase`, new Set(["completed", "failed", "aborted"]));
			nonEmptyString(event.reason, `${name}.reason`);
			break;
		default:
			throw new Error(`unknown journal event type: ${event.type}`);
	}
	return event as unknown as JournalEventData;
}

function validateJournalRecord(value: unknown, line: number, validateEvent = true): JournalRecord {
	const name = `journal record at line ${line}`;
	const record = object(value, name);
	exactKeys(record, name, ["schemaVersion", "seq", "timestamp", "previousHash", "event", "hash"]);
	if (record.schemaVersion !== 1) throw new Error(`unsupported journal schema at line ${line}`);
	safeInteger(record.seq, `${name}.seq`);
	validTimestamp(record.timestamp, `${name}.timestamp`);
	if (
		typeof record.previousHash !== "string" ||
		(record.previousHash !== "" && !/^[a-f0-9]{64}$/.test(record.previousHash))
	) {
		throw new Error(`${name}.previousHash is invalid`);
	}
	if (typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash)) {
		throw new Error(`${name}.hash is invalid`);
	}
	if (validateEvent) validateJournalEvent(record.event);
	return record as unknown as JournalRecord;
}

function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	const directoryFd = openSync(dirname(path), "r");
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class RunStore {
	readonly runDir: string;
	readonly configPath: string;
	readonly journalPath: string;
	readonly snapshotPath: string;
	readonly artifactsDir: string;
	readonly sessionsDir: string;
	readonly lockPath: string;
	readonly ownerLockPath: string;
	readonly config: LongHorizonRunConfig;

	private constructor(runDir: string, config: LongHorizonRunConfig) {
		this.runDir = runDir;
		this.configPath = join(runDir, "config.json");
		this.journalPath = join(runDir, "journal.jsonl");
		this.snapshotPath = join(runDir, "state.json");
		this.artifactsDir = join(runDir, "artifacts");
		this.sessionsDir = join(runDir, "sessions");
		this.lockPath = join(runDir, ".write-lock");
		this.ownerLockPath = join(runDir, ".owner-lock");
		this.config = config;
	}

	static create(config: LongHorizonRunConfig): RunStore {
		const validated = parseRunConfig(config);
		const runDir = resolve(validated.runRoot, validated.runId);
		if (dirname(runDir) !== validated.runRoot || basename(runDir) !== validated.runId) {
			throw new Error("runId must resolve to a direct child of runRoot");
		}
		mkdirSync(validated.runRoot, { recursive: true });
		try {
			mkdirSync(runDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`run already exists: ${runDir}`);
			throw error;
		}
		mkdirSync(join(runDir, "artifacts"));
		mkdirSync(join(runDir, "sessions"));
		const store = new RunStore(runDir, validated);
		atomicWrite(store.configPath, `${JSON.stringify(validated, null, 2)}\n`);
		atomicWrite(store.journalPath, "");
		store.append({ type: "run_created", configDigest: digest(validated) });
		return store;
	}

	static open(runDir: string): RunStore {
		const resolved = resolve(runDir);
		const configPath = join(resolved, "config.json");
		if (!existsSync(configPath)) throw new Error(`run configuration not found: ${configPath}`);
		const config = parseRunConfig(JSON.parse(readFileSync(configPath, "utf8")));
		if (basename(resolved) !== config.runId) throw new Error("run directory does not match configured runId");
		const store = new RunStore(resolved, config);
		const release = store.acquireLock();
		try {
			const records = store.readRecords();
			store.validateArtifactReferences(records);
			const state = replayJournal(records, config);
			if (!existsSync(store.snapshotPath)) {
				atomicWrite(store.snapshotPath, `${JSON.stringify(state, null, 2)}\n`);
				return store;
			}
			let snapshot: RunState;
			try {
				snapshot = JSON.parse(readFileSync(store.snapshotPath, "utf8")) as RunState;
			} catch (error) {
				throw new Error(`invalid state snapshot: ${(error as Error).message}`);
			}
			if (canonical(snapshot) !== canonical(state)) {
				const snapshotSeq = snapshot.lastSeq;
				const isOlderValidSnapshot =
					Number.isSafeInteger(snapshotSeq) &&
					snapshotSeq >= 0 &&
					snapshotSeq < state.lastSeq &&
					canonical(snapshot) === canonical(replayJournal(records.slice(0, snapshotSeq + 1), config));
				if (!isOlderValidSnapshot) throw new Error("state snapshot does not match journal replay");
				atomicWrite(store.snapshotPath, `${JSON.stringify(state, null, 2)}\n`);
			}
			return store;
		} finally {
			release();
		}
	}

	private acquireLock(path = this.lockPath): () => void {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = openSync(path, "wx", 0o600);
				writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
				closeSync(fd);
				return () => {
					try {
						unlinkSync(path);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				let owner: { pid?: number } = {};
				try {
					owner = JSON.parse(readFileSync(path, "utf8"));
				} catch {
					throw new Error(`ambiguous run lock: ${path}`);
				}
				if (owner.pid && processAlive(owner.pid)) throw new Error(`run is locked by process ${owner.pid}`);
				unlinkSync(path);
			}
		}
		throw new Error(`could not acquire run lock: ${path}`);
	}

	acquireOwnership(): () => void {
		return this.acquireLock(this.ownerLockPath);
	}

	readRecords(): JournalRecord[] {
		if (!existsSync(this.journalPath)) throw new Error("journal is missing");
		const content = readFileSync(this.journalPath, "utf8");
		if (content.length > 0 && !content.endsWith("\n")) throw new Error("journal has a truncated final record");
		const records: JournalRecord[] = [];
		for (const [index, line] of content.split("\n").entries()) {
			if (!line) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				throw new Error(`malformed journal record at line ${index + 1}: ${(error as Error).message}`);
			}
			const record = validateJournalRecord(parsed, index + 1, false);
			const { hash, ...unsigned } = record;
			if (hash !== recordHash(unsigned)) throw new Error(`journal checksum mismatch at line ${index + 1}`);
			validateJournalEvent(record.event);
			records.push(record);
		}
		return records;
	}

	replay(): RunState {
		const records = this.readRecords();
		if (records[0]?.event.type !== "run_created" || records[0].event.configDigest !== digest(this.config)) {
			throw new Error("run configuration does not match journal");
		}
		return replayJournal(records, this.config);
	}

	append(event: JournalEventData): RunState {
		const validatedEvent = validateJournalEvent(event);
		let completedHandoff: HandoffArtifact | undefined;
		if (validatedEvent.type === "effect_completed" && validatedEvent.artifact) {
			const artifact = this.readArtifact<unknown>(validatedEvent.artifact, validatedEvent.artifactDigest!);
			if (validatedEvent.kind === "handoff") completedHandoff = validateHandoffArtifact(artifact);
		} else if (validatedEvent.type === "round_completed") {
			this.readArtifact(validatedEvent.artifact, validatedEvent.artifactDigest);
		} else if (validatedEvent.type === "escalation_completed") {
			this.readArtifact(validatedEvent.adviceArtifact, validatedEvent.adviceArtifactDigest);
		} else if (
			validatedEvent.type === "acceptance_completed" ||
			validatedEvent.type === "final_verification_recorded"
		) {
			this.readArtifact(validatedEvent.artifact, validatedEvent.artifactDigest);
		}
		const release = this.acquireLock();
		try {
			const records = this.readRecords();
			const previous = records.length ? replayJournal(records, this.config) : undefined;
			if (completedHandoff && previous?.pendingEffect?.sessionId !== completedHandoff.fromSessionId) {
				throw new Error("handoff intent session does not match the handoff artifact source session");
			}
			const unsigned: Omit<JournalRecord, "hash"> = {
				schemaVersion: 1,
				seq: previous ? previous.lastSeq + 1 : 0,
				timestamp: new Date().toISOString(),
				previousHash: previous?.lastHash ?? "",
				event: validatedEvent,
			};
			const record: JournalRecord = { ...unsigned, hash: recordHash(unsigned) };
			const next = applyJournalRecord(previous, record, this.config);
			const journalFd = openSync(this.journalPath, "a", 0o600);
			try {
				writeSync(journalFd, `${JSON.stringify(record)}\n`);
				fsyncSync(journalFd);
			} finally {
				closeSync(journalFd);
			}
			atomicWrite(this.snapshotPath, `${JSON.stringify(next, null, 2)}\n`);
			return next;
		} finally {
			release();
		}
	}

	private validateArtifactReferences(records: readonly JournalRecord[]): void {
		const checked = new Set<string>();
		const handoffSessions = new Map<string, string>();
		for (const record of records) {
			const event = record.event;
			if (event.type === "effect_intent" && event.kind === "handoff") {
				handoffSessions.set(event.effectId, event.sessionId!);
				continue;
			}
			if (event.type === "effect_abandoned" && event.kind === "handoff") {
				handoffSessions.delete(event.effectId);
				continue;
			}
			if (event.type === "effect_completed" && event.kind === "handoff") {
				const handoff = validateHandoffArtifact(this.readArtifact<unknown>(event.artifact!, event.artifactDigest!));
				if (handoffSessions.get(event.effectId) !== handoff.fromSessionId) {
					throw new Error("handoff intent session does not match the handoff artifact source session");
				}
				handoffSessions.delete(event.effectId);
				checked.add(`${event.artifact}\0${event.artifactDigest}`);
				continue;
			}
			let artifact: string | undefined;
			let expectedDigest: string | undefined;
			if (event.type === "effect_completed" && event.artifact) {
				artifact = event.artifact;
				expectedDigest = event.artifactDigest;
			} else if (event.type === "round_completed") {
				artifact = event.artifact;
				expectedDigest = event.artifactDigest;
			} else if (event.type === "escalation_completed") {
				artifact = event.adviceArtifact;
				expectedDigest = event.adviceArtifactDigest;
			} else if (event.type === "acceptance_completed" || event.type === "final_verification_recorded") {
				artifact = event.artifact;
				expectedDigest = event.artifactDigest;
			}
			if (!artifact || !expectedDigest) continue;
			const key = `${artifact}\0${expectedDigest}`;
			if (checked.has(key)) continue;
			this.readArtifact(artifact, expectedDigest);
			checked.add(key);
		}
	}

	writeArtifact<T>(kind: string, id: string, value: T): string {
		if (!/^[a-z][a-z0-9-]*$/.test(kind) || !/^[a-zA-Z0-9_-]+$/.test(id)) {
			throw new Error("invalid artifact name");
		}
		const path = join(this.artifactsDir, `${kind}-${id}.json`);
		if (existsSync(path)) throw new Error(`artifact already exists: ${path}`);
		atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
		return path;
	}

	artifactDigest(path: string): string {
		const resolved = this.resolveArtifactPath(path);
		return contentDigest(readFileSync(resolved, "utf8"));
	}

	readArtifact<T>(path: string, expectedDigest: string): T {
		artifactDigest(expectedDigest, "expected artifact digest");
		const resolved = this.resolveArtifactPath(path);
		const content = readFileSync(resolved, "utf8");
		if (contentDigest(content) !== expectedDigest) throw new Error(`artifact integrity check failed: ${resolved}`);
		try {
			return JSON.parse(content) as T;
		} catch (error) {
			throw new Error(`invalid artifact JSON: ${(error as Error).message}`);
		}
	}

	private resolveArtifactPath(path: string): string {
		const resolved = resolve(path);
		const contained = relative(resolve(this.artifactsDir), resolved);
		if (!contained || contained.startsWith("..") || resolve(this.artifactsDir, contained) !== resolved) {
			throw new Error("artifact path escapes run directory");
		}
		return resolved;
	}

	acknowledgePendingEffect(reason: string): RunState {
		const pending = this.replay().pendingEffect;
		if (!pending) throw new Error("run has no pending effect to acknowledge");
		if (!reason.trim()) throw new Error("acknowledging a pending effect requires a reason");
		return this.append({ type: "effect_abandoned", ...pending, reason: reason.trim() });
	}

	requestControl(action: "pause" | "resume" | "abort", reason?: string): RunState {
		return this.append({ type: "control_requested", action, reason });
	}
}
