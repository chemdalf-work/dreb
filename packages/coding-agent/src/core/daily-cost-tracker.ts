import { constants, type Dirent, existsSync } from "node:fs";
import { type FileHandle, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { getSessionsDir, getSubagentSessionsDir } from "../config.js";
import { log } from "./logger.js";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface ChildUsageSummary extends UsageTotals {
	id: string;
	agentTypes: string[];
	provider?: string;
	model?: string;
	startedAt: number;
	depth: number;
	sessionFiles: string[];
}

export interface SessionCostSummary {
	children: UsageTotals;
	childSessions: ChildUsageSummary[];
}

export interface DailyCostSnapshot {
	localDate: string;
	main: UsageTotals;
	children: UsageTotals;
	total: UsageTotals;
}

export interface DailyCostWarning {
	threshold: number;
	cost: number;
	localDate: string;
}

export interface DailyCostTrackerOptions {
	sessionsDir?: string;
	subagentSessionsDir?: string | false;
	warningStateDir?: string | false;
	now?: () => Date;
}

interface SessionFileMetadata {
	path: string;
	groupId?: string;
	fileDate: Date | null;
	modifiedAt: Date;
	header?: Record<string, unknown>;
}

interface ParsedSessionFile {
	all: UsageTotals;
	daily: UsageTotals;
	provider?: string;
	model?: string;
}

interface MutableChildGroup {
	id: string;
	agentTypes: Set<string>;
	parentSessionFiles: Set<string>;
	sessionFiles: string[];
	startedAt: number;
	provider?: string;
	model?: string;
	all: UsageTotals;
	daily: UsageTotals;
	depth: number;
}

const ZERO_USAGE: UsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};

function newUsage(): UsageTotals {
	return { ...ZERO_USAGE };
}

function cloneUsage(usage: UsageTotals): UsageTotals {
	return { ...usage };
}

function addUsage(target: UsageTotals, source: UsageTotals): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.cost += source.cost;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function usageFromMessage(message: Record<string, unknown>): UsageTotals {
	const usage = isRecord(message.usage) ? message.usage : {};
	const cost = isRecord(usage.cost) ? usage.cost : {};
	return {
		input: finiteNumber(usage.input),
		output: finiteNumber(usage.output),
		cacheRead: finiteNumber(usage.cacheRead),
		cacheWrite: finiteNumber(usage.cacheWrite),
		totalTokens: finiteNumber(usage.totalTokens),
		cost: finiteNumber(cost.total),
	};
}

function localDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function comparablePath(pathValue: string): string {
	const normalized = resolve(pathValue);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathMatches(left: string, right: string): boolean {
	if (comparablePath(left) === comparablePath(right)) return true;
	return basename(left) === basename(right);
}

/**
 * Parse a session filename timestamp back to a Date.
 * Filename timestamps look like "2026-04-09T18-49-11-406Z" (colons and dots replaced with hyphens).
 * Returns null if the timestamp doesn't match the expected format.
 */
export function filenameTimestampToDate(fileTimestamp: string): Date | null {
	const match = fileTimestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
	if (!match) return null;
	const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Check if two dates fall on the same local calendar day. */
export function isSameLocalDay(date: Date, today: Date): boolean {
	return (
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate()
	);
}

function timestampFromFilename(filename: string): Date | null {
	const underscoreIdx = filename.indexOf("_", 20);
	if (underscoreIdx === -1) return null;
	return filenameTimestampToDate(filename.slice(0, underscoreIdx));
}

function entryDate(
	entry: Record<string, unknown>,
	message: Record<string, unknown>,
	fallback: Date | null,
): Date | null {
	if (typeof message.timestamp === "number") {
		const date = new Date(message.timestamp);
		if (!Number.isNaN(date.getTime())) return date;
	}
	if (typeof entry.timestamp === "string") {
		const date = new Date(entry.timestamp);
		if (!Number.isNaN(date.getTime())) return date;
	}
	return fallback;
}

async function listJsonlFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop()!;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	}
	return files;
}

async function readSessionHeader(filePath: string): Promise<Record<string, unknown> | undefined> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(filePath, constants.O_RDONLY);
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0]?.trim();
		if (!firstLine) return undefined;
		const parsed = JSON.parse(firstLine);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function inspectSessionFiles(root: string, childRoot?: string): Promise<SessionFileMetadata[]> {
	const files = await listJsonlFiles(root);
	const metadata: SessionFileMetadata[] = [];
	for (const path of files) {
		const fileDate = timestampFromFilename(basename(path));
		if (!fileDate) continue;
		try {
			const fileStat = await stat(path);
			const relativePath = childRoot ? relative(childRoot, path) : undefined;
			const groupId = relativePath && !relativePath.startsWith("..") ? relativePath.split(sep)[0] : undefined;
			metadata.push({
				path,
				groupId,
				fileDate,
				modifiedAt: fileStat.mtime,
				header: childRoot ? await readSessionHeader(path) : undefined,
			});
		} catch {
			// Files may disappear while a child exits or rotates its session log.
		}
	}
	return metadata;
}

async function parseSessionFile(
	metadata: SessionFileMetadata,
	today: Date,
	includeAll: boolean,
): Promise<ParsedSessionFile> {
	const result: ParsedSessionFile = { all: newUsage(), daily: newUsage() };
	try {
		const content = await readFile(metadata.path, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
				const message = entry.message;
				if (message.role !== "assistant") continue;
				const usage = usageFromMessage(message);
				if (includeAll) addUsage(result.all, usage);
				const date = entryDate(entry, message, metadata.fileDate);
				if (date && isSameLocalDay(date, today)) addUsage(result.daily, usage);
				if (typeof message.provider === "string") result.provider = message.provider;
				if (typeof message.model === "string") result.model = message.model;
			} catch {
				// A partially-written or malformed JSONL line does not invalidate valid entries.
			}
		}
	} catch {
		// An unreadable file contributes no usage; other files remain countable.
	}
	return result;
}

function findOrderedDescendantDepths(
	groups: Map<string, MutableChildGroup>,
	parentSessionFile?: string,
): Map<string, number> {
	const orderedDepths = new Map<string, number>();
	if (!parentSessionFile) return orderedDepths;

	type ParentLink = { depth: number; groupId: string | undefined };
	const descendants = new Map<string, ParentLink>();
	const knownParentFiles = new Map<string, ParentLink>([
		[comparablePath(parentSessionFile), { depth: 0, groupId: undefined }],
	]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const group of groups.values()) {
			if (descendants.has(group.id)) continue;
			let parentLink: ParentLink | undefined;
			for (const parent of group.parentSessionFiles) {
				for (const [knownFile, candidate] of knownParentFiles) {
					if (!pathMatches(parent, knownFile)) continue;
					if (
						!parentLink ||
						candidate.depth < parentLink.depth ||
						(candidate.depth === parentLink.depth &&
							(candidate.groupId ?? "").localeCompare(parentLink.groupId ?? "") < 0)
					) {
						parentLink = candidate;
					}
				}
			}
			if (!parentLink) continue;
			const descendant = { depth: parentLink.depth + 1, groupId: parentLink.groupId };
			descendants.set(group.id, descendant);
			for (const file of group.sessionFiles) {
				knownParentFiles.set(comparablePath(file), { depth: descendant.depth, groupId: group.id });
			}
			changed = true;
		}
	}

	const childrenByParent = new Map<string | undefined, MutableChildGroup[]>();
	for (const [groupId, { groupId: parentGroupId }] of descendants) {
		const siblings = childrenByParent.get(parentGroupId) ?? [];
		siblings.push(groups.get(groupId)!);
		childrenByParent.set(parentGroupId, siblings);
	}
	for (const siblings of childrenByParent.values()) {
		siblings.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	}

	const visitChildren = (parentGroupId: string | undefined): void => {
		for (const group of childrenByParent.get(parentGroupId) ?? []) {
			orderedDepths.set(group.id, descendants.get(group.id)!.depth);
			visitChildren(group.id);
		}
	};
	visitChildren(undefined);
	return orderedDepths;
}

function publicChildSummary(group: MutableChildGroup): ChildUsageSummary {
	return {
		...cloneUsage(group.all),
		id: group.id,
		agentTypes: [...group.agentTypes].sort(),
		provider: group.provider,
		model: group.model,
		startedAt: group.startedAt,
		depth: group.depth,
		sessionFiles: [...group.sessionFiles],
	};
}

/**
 * Tracks same-local-day usage across main sessions and all descendant subagents.
 * JSONL remains authoritative; cached snapshots make footer reads O(1).
 */
export class DailyCostTracker {
	private static readonly REFRESH_INTERVAL_MS = 60_000;
	private static readonly WARNING_INCREMENT = 50;

	private snapshot: DailyCostSnapshot;
	private sessionSummary: SessionCostSummary = { children: newUsage(), childSessions: [] };
	private pendingWarnings: DailyCostWarning[] = [];
	private inMemoryWarningClaims = new Set<string>();
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshQueue: Promise<void> = Promise.resolve();
	private disposed = false;
	private trackedParentSessionFile?: string;
	private readonly sessionsDir: string;
	private readonly subagentSessionsDir?: string;
	private readonly warningStateDir?: string;
	private readonly now: () => Date;

	constructor(options?: string | DailyCostTrackerOptions) {
		const resolvedOptions: DailyCostTrackerOptions =
			typeof options === "string" ? { sessionsDir: options } : (options ?? {});
		this.sessionsDir = resolvedOptions.sessionsDir ?? getSessionsDir();
		this.subagentSessionsDir =
			resolvedOptions.subagentSessionsDir === false
				? undefined
				: (resolvedOptions.subagentSessionsDir ??
					(typeof options === "string" ? undefined : getSubagentSessionsDir()));
		this.warningStateDir = resolvedOptions.warningStateDir === false ? undefined : resolvedOptions.warningStateDir;
		this.now = resolvedOptions.now ?? (() => new Date());
		this.snapshot = {
			localDate: localDateKey(this.now()),
			main: newUsage(),
			children: newUsage(),
			total: newUsage(),
		};
		void this.initialScan();
	}

	/** Cached aggregate currency cost across main and descendant sessions today. */
	getDailyCost(): number {
		return this.snapshot.total.cost;
	}

	getSnapshot(): DailyCostSnapshot {
		return {
			localDate: this.snapshot.localDate,
			main: cloneUsage(this.snapshot.main),
			children: cloneUsage(this.snapshot.children),
			total: cloneUsage(this.snapshot.total),
		};
	}

	getSessionCostSummary(parentSessionFile?: string): SessionCostSummary {
		if (
			!parentSessionFile ||
			!this.trackedParentSessionFile ||
			!pathMatches(parentSessionFile, this.trackedParentSessionFile)
		) {
			return { children: newUsage(), childSessions: [] };
		}
		return {
			children: cloneUsage(this.sessionSummary.children),
			childSessions: this.sessionSummary.childSessions.map((child) => ({
				...child,
				agentTypes: [...child.agentTypes],
				sessionFiles: [...child.sessionFiles],
			})),
		};
	}

	consumeWarnings(): DailyCostWarning[] {
		return this.pendingWarnings.splice(0);
	}

	/** Force an async refresh. Passing a parent enables all-time descendant totals for that session. */
	async refresh(parentSessionFile?: string): Promise<void> {
		if (this.disposed) return;
		if (parentSessionFile) this.trackedParentSessionFile = parentSessionFile;
		const queued = this.refreshQueue.then(async () => {
			if (!this.disposed) await this.performRefresh();
		});
		this.refreshQueue = queued.catch(() => undefined);
		await queued;
	}

	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
	}

	private async initialScan(): Promise<void> {
		await this.refresh();
		if (!this.disposed) this.scheduleNextRefresh();
	}

	private scheduleNextRefresh(): void {
		if (this.disposed) return;
		this.refreshTimer = setTimeout(async () => {
			this.refreshTimer = null;
			await this.refresh();
			if (!this.disposed) this.scheduleNextRefresh();
		}, DailyCostTracker.REFRESH_INTERVAL_MS);
		this.refreshTimer.unref?.();
	}

	private async performRefresh(): Promise<void> {
		const today = this.now();
		const main = newUsage();
		const children = newUsage();
		const childGroups = new Map<string, MutableChildGroup>();

		const mainFiles = await inspectSessionFiles(this.sessionsDir);
		for (const metadata of mainFiles) {
			if (!isSameLocalDay(metadata.fileDate!, today) && !isSameLocalDay(metadata.modifiedAt, today)) continue;
			const parsed = await parseSessionFile(metadata, today, false);
			addUsage(main, parsed.daily);
		}

		if (this.subagentSessionsDir) {
			const childFiles = await inspectSessionFiles(this.subagentSessionsDir, this.subagentSessionsDir);
			for (const metadata of childFiles) {
				if (!metadata.groupId) continue;
				const header = metadata.header;
				let group = childGroups.get(metadata.groupId);
				if (!group) {
					group = {
						id: metadata.groupId,
						agentTypes: new Set(),
						parentSessionFiles: new Set(),
						sessionFiles: [],
						startedAt: metadata.fileDate?.getTime() ?? metadata.modifiedAt.getTime(),
						all: newUsage(),
						daily: newUsage(),
						depth: 0,
					};
					childGroups.set(metadata.groupId, group);
				}
				group.sessionFiles.push(metadata.path);
				group.startedAt = Math.min(group.startedAt, metadata.fileDate?.getTime() ?? metadata.modifiedAt.getTime());
				if (typeof header?.agentType === "string" && header.agentType.trim())
					group.agentTypes.add(header.agentType);
				if (typeof header?.parentSession === "string" && header.parentSession.trim()) {
					group.parentSessionFiles.add(header.parentSession);
				}
			}

			const descendantDepths = findOrderedDescendantDepths(childGroups, this.trackedParentSessionFile);
			for (const metadata of childFiles) {
				if (!metadata.groupId) continue;
				const group = childGroups.get(metadata.groupId)!;
				const isDescendant = descendantDepths.has(group.id);
				const isDailyCandidate =
					(metadata.fileDate !== null && isSameLocalDay(metadata.fileDate, today)) ||
					isSameLocalDay(metadata.modifiedAt, today);
				if (!isDescendant && !isDailyCandidate) continue;
				const parsed = await parseSessionFile(metadata, today, isDescendant);
				addUsage(group.daily, parsed.daily);
				if (isDescendant) addUsage(group.all, parsed.all);
				if (parsed.provider) group.provider = parsed.provider;
				if (parsed.model) group.model = parsed.model;
			}

			for (const group of childGroups.values()) addUsage(children, group.daily);

			const sessionChildren = newUsage();
			const childSessions: ChildUsageSummary[] = [];
			for (const [groupId, depth] of descendantDepths) {
				const group = childGroups.get(groupId)!;
				group.depth = depth;
				addUsage(sessionChildren, group.all);
				childSessions.push(publicChildSummary(group));
			}
			this.sessionSummary = { children: sessionChildren, childSessions };
		} else {
			this.sessionSummary = { children: newUsage(), childSessions: [] };
		}

		const total = cloneUsage(main);
		addUsage(total, children);
		if (this.disposed) return;
		this.snapshot = { localDate: localDateKey(today), main, children, total };
		await this.collectWarnings(total.cost, today);
	}

	private async collectWarnings(cost: number, today: Date): Promise<void> {
		const highest = Math.floor(cost / DailyCostTracker.WARNING_INCREMENT) * DailyCostTracker.WARNING_INCREMENT;
		if (highest < DailyCostTracker.WARNING_INCREMENT) return;
		const date = localDateKey(today);
		for (
			let threshold = DailyCostTracker.WARNING_INCREMENT;
			threshold <= highest;
			threshold += DailyCostTracker.WARNING_INCREMENT
		) {
			if (!(await this.claimWarning(date, threshold))) continue;
			this.pendingWarnings.push({ threshold, cost, localDate: date });
		}
	}

	private async claimWarning(date: string, threshold: number): Promise<boolean> {
		const key = `${date}:${threshold}`;
		if (!this.warningStateDir) {
			if (this.inMemoryWarningClaims.has(key)) return false;
			this.inMemoryWarningClaims.add(key);
			return true;
		}
		const dayDir = join(this.warningStateDir, date);
		const marker = join(dayDir, `${threshold}.warned`);
		let handle: FileHandle | undefined;
		try {
			await mkdir(dayDir, { recursive: true });
			handle = await open(marker, "wx");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			log.warn(
				`[daily-cost] could not persist warning threshold ${threshold}: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (this.inMemoryWarningClaims.has(key)) return false;
			this.inMemoryWarningClaims.add(key);
			return true;
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}
}
