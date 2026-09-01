import type { SearchDatabase } from "./db.js";

export type DependencyDirection = "dependencies" | "dependents" | "both";

export interface DependencyGraphOptions {
	direction?: DependencyDirection;
	depth?: number;
	limit?: number;
}

export interface DependencyGraphNode {
	filePath: string;
	depth: number;
	via: string;
	relationship: "imports" | "imported_by" | "imports_and_imported_by";
}

export interface DependencyGraphResult {
	root: string;
	nodes: DependencyGraphNode[];
	truncated: boolean;
}

/**
 * Traverse the already-indexed file import graph without running embeddings.
 * Results are breadth-first, deterministic, and bounded by depth and count.
 */
export function queryDependencyGraph(
	db: SearchDatabase,
	filePath: string,
	options: DependencyGraphOptions = {},
): DependencyGraphResult {
	const direction = options.direction ?? "both";
	const maxDepth = clampInteger(options.depth, 1, 3, 1);
	const limit = clampInteger(options.limit, 1, 100, 30);
	const files = db.getAllFiles();
	const byId = new Map(files.map((file) => [file.id, file]));
	const aliases = buildPathAliases(files.map((file) => [file.id, file.filePath] as const));
	const rootId = resolvePath(filePath, aliases);
	if (rootId === undefined) {
		throw new Error(`File is not present in the repository index: ${filePath}`);
	}

	const visited = new Set([rootId]);
	const queue: Array<{ id: number; depth: number }> = [{ id: rootId, depth: 0 }];
	const nodes: DependencyGraphNode[] = [];
	let truncated = false;

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current.depth >= maxDepth) continue;
		const neighborRelationships = new Map<number, DependencyGraphNode["relationship"]>();
		const addNeighbor = (id: number, relationship: "imports" | "imported_by") => {
			const existing = neighborRelationships.get(id);
			neighborRelationships.set(
				id,
				existing && existing !== relationship ? "imports_and_imported_by" : relationship,
			);
		};
		if (direction === "dependencies" || direction === "both") {
			for (const targetPath of db.getImportsFrom(current.id)) {
				const targetId = resolvePath(targetPath, aliases);
				if (targetId !== undefined) addNeighbor(targetId, "imports");
			}
		}
		if (direction === "dependents" || direction === "both") {
			const currentPath = byId.get(current.id)?.filePath;
			if (currentPath) {
				const candidateImporterIds = new Set<number>();
				for (const alias of pathAliases(currentPath)) {
					for (const importerId of db.getImportersOf(alias)) candidateImporterIds.add(importerId);
				}
				for (const importerId of candidateImporterIds) {
					const resolvesToCurrent = db
						.getImportsFrom(importerId)
						.some((importedPath) => resolvePath(importedPath, aliases) === current.id);
					if (resolvesToCurrent) addNeighbor(importerId, "imported_by");
				}
			}
		}
		const neighbors = [...neighborRelationships].map(([id, relationship]) => ({ id, relationship }));
		neighbors.sort((a, b) => (byId.get(a.id)?.filePath ?? "").localeCompare(byId.get(b.id)?.filePath ?? ""));

		for (const neighbor of neighbors) {
			if (visited.has(neighbor.id)) continue;
			visited.add(neighbor.id);
			const file = byId.get(neighbor.id);
			const via = byId.get(current.id);
			if (!file || !via) continue;
			if (nodes.length >= limit) {
				truncated = true;
				continue;
			}
			const depth = current.depth + 1;
			nodes.push({ filePath: file.filePath, depth, via: via.filePath, relationship: neighbor.relationship });
			queue.push({ id: neighbor.id, depth });
		}
	}

	return { root: byId.get(rootId)!.filePath, nodes, truncated };
}

function buildPathAliases(files: ReadonlyArray<readonly [number, string]>): Map<string, number | undefined> {
	const aliases = new Map<string, number | undefined>();
	for (const [id, filePath] of files) {
		for (const alias of pathAliases(filePath)) {
			const existing = aliases.get(alias);
			aliases.set(alias, existing === undefined && !aliases.has(alias) ? id : existing === id ? id : undefined);
		}
	}
	return aliases;
}

function resolvePath(filePath: string, aliases: Map<string, number | undefined>): number | undefined {
	for (const alias of pathAliases(normalizePath(filePath))) {
		const id = aliases.get(alias);
		if (id !== undefined) return id;
	}
	return undefined;
}

function pathAliases(filePath: string): string[] {
	const normalized = normalizePath(filePath);
	const stripped = normalized.replace(
		/(?:\.d\.[cm]?ts|\.[cm]?[jt]sx?|\.py|\.go|\.rs|\.java|\.c|\.h|\.cpp|\.hpp|\.cc|\.cxx)$/,
		"",
	);
	const aliases = new Set([normalized, stripped]);
	if (stripped.endsWith("/index")) aliases.add(stripped.slice(0, -"/index".length));
	return [...aliases];
}

function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}
