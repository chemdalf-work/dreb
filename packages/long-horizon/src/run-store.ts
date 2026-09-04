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
import { applyJournalRecord, replayJournal } from "./state-machine.js";
import type { JournalEventData, JournalRecord, LongHorizonRunConfig, RunState } from "./types.js";

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
			let record: JournalRecord;
			try {
				record = JSON.parse(line) as JournalRecord;
			} catch (error) {
				throw new Error(`malformed journal record at line ${index + 1}: ${(error as Error).message}`);
			}
			if (record.schemaVersion !== 1) throw new Error(`unsupported journal schema at line ${index + 1}`);
			const { hash, ...unsigned } = record;
			if (hash !== recordHash(unsigned)) throw new Error(`journal checksum mismatch at line ${index + 1}`);
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
		const release = this.acquireLock();
		try {
			const records = this.readRecords();
			const previous = records.length ? replayJournal(records, this.config) : undefined;
			const unsigned: Omit<JournalRecord, "hash"> = {
				schemaVersion: 1,
				seq: previous ? previous.lastSeq + 1 : 0,
				timestamp: new Date().toISOString(),
				previousHash: previous?.lastHash ?? "",
				event,
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

	writeArtifact<T>(kind: string, id: string, value: T): string {
		if (!/^[a-z][a-z0-9-]*$/.test(kind) || !/^[a-zA-Z0-9_-]+$/.test(id)) {
			throw new Error("invalid artifact name");
		}
		const path = join(this.artifactsDir, `${kind}-${id}.json`);
		if (existsSync(path)) throw new Error(`artifact already exists: ${path}`);
		atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
		return path;
	}

	readArtifact<T>(path: string): T {
		const resolved = resolve(path);
		const contained = relative(resolve(this.artifactsDir), resolved);
		if (!contained || contained.startsWith("..") || resolve(this.artifactsDir, contained) !== resolved) {
			throw new Error("artifact path escapes run directory");
		}
		return JSON.parse(readFileSync(resolved, "utf8")) as T;
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
