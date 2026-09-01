/**
 * Semantic codebase search tool.
 *
 * Uses embeddings + FTS5 to support natural language queries over the codebase.
 * Feature-gated on `node:sqlite` availability (Node 22+).
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentTool } from "@dreb/agent-core";
import { StringEnum } from "@dreb/ai";
import { type DependencyDirection, formatResults, SearchEngine } from "@dreb/semantic-search";
import { Text } from "@dreb/tui";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getDrebToolVisibleDirs } from "./dreb-paths.js";
import { resolveToCwd } from "./path-utils.js";
import { shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

// ============================================================================
// Schema
// ============================================================================

const searchSchema = Type.Object({
	query: Type.String({ description: "The search query (natural language, identifier, or path)" }),
	restrictToDir: Type.Optional(
		Type.String({
			description:
				"Filter results to files under this path (relative to searchDir or cwd). Does not affect indexing — the entire searchDir is still indexed.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 20)" })),
	searchDir: Type.Optional(
		Type.String({
			description:
				"Directory to index and search instead of cwd (useful when cwd is ~/). The entire contents of this directory are scanned and indexed.",
		}),
	),
	rebuild: Type.Optional(Type.Boolean({ description: "Force a clean rebuild of the search index (default: false)" })),
});

export type SearchToolInput = Static<typeof searchSchema>;

const repoGraphSchema = Type.Object({
	file: Type.String({ description: "Indexed repository-relative file path to inspect" }),
	direction: Type.Optional(
		StringEnum(["dependencies", "dependents", "both"] as const, {
			description: "Traverse imports, importers, or both (default: both)",
		}),
	),
	depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "Traversal depth (default: 1)" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum related files (default: 30)" })),
	searchDir: Type.Optional(
		Type.String({
			description: "Repository root to index instead of cwd",
		}),
	),
	rebuild: Type.Optional(Type.Boolean({ description: "Force a clean index rebuild before traversal" })),
});

export type RepoGraphToolInput = Static<typeof repoGraphSchema>;

// ============================================================================
// Details
// ============================================================================

export interface SearchToolDetails {
	resultCount: number;
	indexBuilt: boolean;
	indexStats?: { files: number; chunks: number };
}

export interface RepoGraphToolDetails {
	root?: string;
	resultCount: number;
	truncated: boolean;
	indexBuilt: boolean;
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ============================================================================
// Rendering
// ============================================================================

/** @internal Exported for testing. */
export function formatSearchCall(
	args: { query?: string; restrictToDir?: string; limit?: number; searchDir?: string; rebuild?: boolean } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const query = str(args?.query);
	const restrictToDir = str(args?.restrictToDir);
	const searchDir = str(args?.searchDir);
	let text = `${theme.fg("toolTitle", theme.bold("search"))} ${theme.fg("accent", `"${query ?? ""}"`)}`;
	if (searchDir) {
		text += theme.fg("toolOutput", ` project ${shortenPath(searchDir)}`);
	}
	if (restrictToDir) {
		text += theme.fg("toolOutput", ` in ${shortenPath(restrictToDir)}`);
	}
	if (args?.rebuild) {
		text += theme.fg("toolOutput", " [rebuild]");
	}
	if (args?.limit !== undefined) {
		text += theme.fg("toolOutput", ` limit ${args.limit}`);
	}
	return text;
}

/** @internal Exported for testing. */
export function formatSearchResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: SearchToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const output = result.content[0]?.text ? normalizeLineEndings(result.content[0].text).trim() : "";
	if (!output) return "";

	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 20;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;

	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
	}

	if (result.details?.indexStats) {
		const { files, chunks } = result.details.indexStats;
		text += `\n${theme.fg("muted", `[Index: ${files} files, ${chunks} chunks]`)}`;
	}

	return text;
}

// ============================================================================
// Tool Definition
// ============================================================================

/** Check if the search tool is available (requires node:sqlite). */
export function isSearchAvailable(): boolean {
	return SearchEngine.isAvailable();
}

// Cache search engines per project root to reuse index across calls within a session
const engineCache = new Map<string, SearchEngine>();

function getSearchEngine(projectRoot: string): SearchEngine {
	let engine = engineCache.get(projectRoot);
	if (!engine) {
		engine = new SearchEngine(projectRoot, {
			indexDir: path.join(projectRoot, ".dreb", "index"),
			globalMemoryDir: path.join(homedir(), ".dreb", "memory"),
			modelCacheDir: path.join(homedir(), ".dreb", "agent", "models"),
			visibleDirs: getDrebToolVisibleDirs,
		});
		engineCache.set(projectRoot, engine);
	}
	return engine;
}

export function createSearchToolDefinition(cwd: string): ToolDefinition<typeof searchSchema, SearchToolDetails> {
	return {
		name: "search",
		label: "search",
		description:
			"Search the codebase using natural language queries. Returns ranked code/doc results using semantic similarity and keyword matching. First query builds the index (may take a moment); subsequent queries are fast. Supports identifier queries (e.g. 'AuthMiddleware'), natural language (e.g. 'where is rate limiting handled'), and path queries (e.g. 'src/auth/').",
		promptSnippet: "Semantic codebase search — natural language queries over code and docs",
		promptGuidelines: [
			"Use `search` as your default exploration tool — for understanding code, finding where things are, and answering questions about the codebase. Use `grep` when you already know the exact text or pattern you're looking for.",
			"The first search query builds an index (may take 10-60s). Subsequent queries are fast.",
		],
		parameters: searchSchema,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			if (signal?.aborted) throw new Error("Operation aborted");

			if (!isSearchAvailable()) {
				return {
					content: [
						{
							type: "text",
							text: "Semantic search requires Node.js 22+ (for built-in SQLite). Current Node.js version does not support node:sqlite.",
						},
					],
					details: { resultCount: 0, indexBuilt: false },
				};
			}

			const { query, restrictToDir, limit, searchDir, rebuild } = params;

			if (!query || query.trim().length === 0) {
				return {
					content: [{ type: "text", text: "Search query cannot be empty." }],
					details: { resultCount: 0, indexBuilt: false },
				};
			}

			const resolvedSearchDir = searchDir ? resolveToCwd(searchDir, cwd) : cwd;

			if (searchDir && (!existsSync(resolvedSearchDir) || !statSync(resolvedSearchDir).isDirectory())) {
				return {
					content: [
						{
							type: "text",
							text: `searchDir does not exist or is not a directory: ${resolvedSearchDir}`,
						},
					],
					details: { resultCount: 0, indexBuilt: false },
				};
			}

			const engine = getSearchEngine(resolvedSearchDir);

			if (rebuild) {
				await engine.resetIndex();
			}

			let indexBuilt = false;
			const results = await engine.search(query, {
				limit: typeof limit === "number" && limit > 0 ? Math.floor(limit) : 20,
				pathFilter: restrictToDir,
				onProgress: (phase, current, total) => {
					if (phase === "indexing" || phase === "scanning" || phase === "loading model" || phase === "embedding") {
						indexBuilt = true;
					}
					if (onUpdate) {
						onUpdate({
							content: [
								{
									type: "text",
									text: `${phase}: ${current}/${total}`,
								},
							],
							details: { resultCount: 0, indexBuilt: true } as SearchToolDetails,
						});
					}
				},
			});

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No results found." }],
					details: { resultCount: 0, indexBuilt },
				};
			}

			const text = formatResults(results);

			// Get index stats from the existing engine (no new connection)
			const stats = engine.getStats();

			return {
				content: [{ type: "text", text }],
				details: {
					resultCount: results.length,
					indexBuilt,
					indexStats: stats ?? undefined,
				},
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
			text.setText(formatSearchCall(args, theme));
			return text;
		},

		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0, undefined, true);
			text.setText(formatSearchResult(result as any, options, theme));
			return text;
		},
	};
}

export function createRepoGraphToolDefinition(
	cwd: string,
): ToolDefinition<typeof repoGraphSchema, RepoGraphToolDetails> {
	return {
		name: "repo_graph",
		label: "repo graph",
		description:
			"Traverse the repository's indexed file-import graph. Use for bounded dependency, dependent, and impact-neighborhood questions; use search for semantic discovery and source/tests for runtime proof.",
		promptSnippet: "Bounded repository file dependency traversal using the existing local search index",
		promptGuidelines: [
			"Use `repo_graph` after locating a relevant file when import/dependent relationships matter. Keep depth small and verify runtime claims in source or tests.",
			"This is a static file-import graph, not a call graph. Dynamic imports, reflection, generated code, and runtime wiring may be absent.",
		],
		parameters: repoGraphSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) throw new Error("Operation aborted");
			if (!isSearchAvailable()) {
				return {
					content: [{ type: "text", text: "Repository graph requires Node.js 22+ (for built-in SQLite)." }],
					details: { resultCount: 0, truncated: false, indexBuilt: false },
				};
			}

			const projectRoot = params.searchDir ? resolveToCwd(params.searchDir, cwd) : cwd;
			if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
				return {
					content: [{ type: "text", text: `searchDir does not exist or is not a directory: ${projectRoot}` }],
					details: { resultCount: 0, truncated: false, indexBuilt: false },
				};
			}

			const engine = getSearchEngine(projectRoot);
			if (params.rebuild) await engine.resetIndex();
			let indexBuilt = false;
			const result = await engine.dependencyGraph(params.file, {
				direction: params.direction as DependencyDirection | undefined,
				depth: params.depth,
				limit: params.limit,
				onProgress: (phase, current, total) => {
					indexBuilt = true;
					onUpdate?.({
						content: [{ type: "text", text: `${phase}: ${current}/${total}` }],
						details: { resultCount: 0, truncated: false, indexBuilt: true },
					});
				},
			});
			const lines = result.nodes.map(
				(node) => `- depth ${node.depth} [${node.relationship}] ${node.filePath} (via ${node.via})`,
			);
			const text = [
				`Dependency graph for ${result.root}`,
				...(lines.length > 0 ? lines : ["No related indexed files found."]),
				...(result.truncated ? ["[Results truncated at the requested limit.]"] : []),
				"Static import evidence only; verify runtime behavior in source and tests.",
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					root: result.root,
					resultCount: result.nodes.length,
					truncated: result.truncated,
					indexBuilt,
				},
			};
		},
	};
}

export function createSearchTool(cwd: string): AgentTool<typeof searchSchema> {
	return wrapToolDefinition(createSearchToolDefinition(cwd));
}

export function createRepoGraphTool(cwd: string): AgentTool<typeof repoGraphSchema> {
	return wrapToolDefinition(createRepoGraphToolDefinition(cwd));
}

/** Default search and repository graph tools using process.cwd() for backwards compatibility. */
export const searchToolDefinition = createSearchToolDefinition(process.cwd());
export const searchTool = createSearchTool(process.cwd());
export const repoGraphToolDefinition = createRepoGraphToolDefinition(process.cwd());
export const repoGraphTool = createRepoGraphTool(process.cwd());
