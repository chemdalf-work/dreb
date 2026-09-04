/**
 * Index lifecycle manager.
 *
 * Orchestrates: file scanning → chunking → embedding → FTS indexing → import graph.
 * Supports incremental updates via mtime comparison.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chunkFile } from "./chunker.js";
import type { SearchDatabase } from "./db.js";
import { isSqliteAvailable, SearchDatabase as SearchDatabaseClass } from "./db.js";
import type { Embedder } from "./embedder.js";
import { type ScannedFile, scanProject } from "./scanner.js";
import type { IndexBuildResult, IndexConfig, IndexedFile, IndexProgressCallback } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const DB_FILENAME = "search.db";
const BUILD_LOCK_DIRNAME = ".build-lock";
const BUILD_LOCK_RETRY_MS = 50;
const BUILD_LOCK_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isDatabaseError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code === "string" && code.includes("SQLITE")) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /database is locked|database or disk is full|constraint failed|cannot start a transaction/i.test(message);
}

// ============================================================================
// Index Manager
// ============================================================================

export class IndexManager {
	private readonly config: IndexConfig;
	private db: SearchDatabase | null = null;
	private embedder: Embedder | null = null;

	constructor(config: IndexConfig) {
		this.config = config;
	}

	/** Check if node:sqlite is available. */
	static isAvailable(): boolean {
		return isSqliteAvailable();
	}

	/** Open or create the index database. */
	open(): SearchDatabase {
		if (this.db) return this.db;

		mkdirSync(this.config.indexDir, { recursive: true });
		const dbPath = path.join(this.config.indexDir, DB_FILENAME);
		this.db = new SearchDatabaseClass(dbPath);
		return this.db;
	}

	/**
	 * Set an external embedder instance to share with the caller.
	 * When set, embedChunks() uses this instead of creating its own.
	 */
	setEmbedder(embedder: Embedder): void {
		this.embedder = embedder;
	}

	/** Close the database and dispose resources. */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		// Only dispose the embedder if we own it (not shared externally).
		// The caller who set it via setEmbedder() is responsible for its lifecycle.
		this.embedder = null;
	}

	/** Get the database, opening if needed. */
	getDb(): SearchDatabase {
		if (!this.db) return this.open();
		return this.db;
	}

	private isBuildLockStale(lockDir: string): boolean {
		try {
			const owner = readFileSync(path.join(lockDir, "owner"), "utf8").trim();
			const pid = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
			if (!Number.isSafeInteger(pid) || pid <= 0) return false;
			try {
				process.kill(pid, 0);
				return false;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === "ESRCH";
			}
		} catch {
			return false;
		}
	}

	private async acquireBuildLock(): Promise<() => void> {
		mkdirSync(this.config.indexDir, { recursive: true });
		const lockDir = path.join(this.config.indexDir, BUILD_LOCK_DIRNAME);
		const token = `${process.pid}:${randomUUID()}`;
		const deadline = Date.now() + BUILD_LOCK_TIMEOUT_MS;

		while (true) {
			try {
				mkdirSync(lockDir);
				try {
					writeFileSync(path.join(lockDir, "owner"), token, "utf8");
				} catch (error) {
					rmSync(lockDir, { recursive: true, force: true });
					throw error;
				}
				return () => {
					try {
						if (readFileSync(path.join(lockDir, "owner"), "utf8").trim() === token) {
							rmSync(lockDir, { recursive: true, force: true });
						}
					} catch {
						// The lock was already removed or replaced; do not remove another owner's lock.
					}
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (this.isBuildLockStale(lockDir)) {
					rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
				if (Date.now() >= deadline) {
					throw new Error(`Timed out waiting for repository index lock: ${lockDir}`);
				}
				await delay(BUILD_LOCK_RETRY_MS);
			}
		}
	}

	/**
	 * Build or incrementally update the index.
	 *
	 * 1. Scan project for files
	 * 2. Compare mtimes against stored records
	 * 3. Re-chunk and re-embed only changed/new files
	 * 4. Remove deleted files
	 */
	async buildIndex(onProgress?: IndexProgressCallback, options: { embed?: boolean } = {}): Promise<IndexBuildResult> {
		const releaseLock = await this.acquireBuildLock();
		try {
			return await this.buildIndexUnlocked(onProgress, options);
		} finally {
			releaseLock();
		}
	}

	private async buildIndexUnlocked(
		onProgress?: IndexProgressCallback,
		options: { embed?: boolean } = {},
	): Promise<IndexBuildResult> {
		const db = this.getDb();
		const config = this.config;

		// Phase 1: Scan
		onProgress?.("scanning", 0, 1);
		const scannedFiles = await scanProject(config.projectRoot, config.globalMemoryDir, config.visibleDirs);
		onProgress?.("scanning", 1, 1);

		// Phase 2: Diff against existing index
		const existingFiles = db.getAllFiles();
		const existingByPath = new Map<string, IndexedFile>();
		for (const f of existingFiles) {
			existingByPath.set(f.filePath, f);
		}

		const scannedByPath = new Map<string, ScannedFile>();
		for (const f of scannedFiles) {
			scannedByPath.set(f.filePath, f);
		}

		const toAdd: ScannedFile[] = [];
		const toUpdate: ScannedFile[] = [];
		const toRemove: IndexedFile[] = [];

		// Find new and changed files
		for (const scanned of scannedFiles) {
			const existing = existingByPath.get(scanned.filePath);
			if (!existing) {
				toAdd.push(scanned);
			} else if (existing.mtime !== scanned.mtime) {
				toUpdate.push(scanned);
			}
		}

		// Find deleted files
		for (const existing of existingFiles) {
			if (!scannedByPath.has(existing.filePath)) {
				toRemove.push(existing);
			}
		}

		const totalWork = toAdd.length + toUpdate.length + toRemove.length;
		if (totalWork === 0) {
			return { added: 0, updated: 0, removed: 0, failed: 0 };
		}

		// Phase 3: Remove deleted files
		for (const file of toRemove) {
			db.deleteFile(file.id);
		}

		// Phase 4: Process new and changed files
		const filesToProcess = [...toAdd, ...toUpdate];
		const allNewChunkIds: number[] = [];
		let failed = 0;

		for (let i = 0; i < filesToProcess.length; i++) {
			const scanned = filesToProcess[i];
			onProgress?.("indexing", i + 1, filesToProcess.length);

			try {
				// Read file content and chunk BEFORE the transaction so that
				// failures in I/O or chunking don't leave a committed mtime
				// with zero chunks (which would make the file permanently invisible).
				const absPath = scanned.filePath.startsWith("~memory/")
					? path.join(this.config.globalMemoryDir ?? "", scanned.filePath.replace("~memory/", ""))
					: path.join(config.projectRoot, scanned.filePath);

				const content = readFileSync(absPath, "utf-8");
				const chunks = await chunkFile(content, scanned.filePath, scanned.fileType);
				const imports = extractImports(content, scanned.filePath, scanned.fileType);

				// All DB mutations in a single transaction — atomic per file.
				// Always clear by the upserted ID: another process may have inserted
				// this file after our initial snapshot classified it as new.
				db.transaction(() => {
					const fileId = db.upsertFile(scanned.filePath, scanned.mtime, scanned.fileType);
					db.deleteChunksForFile(fileId);
					db.deleteImportsForFile(fileId);

					// Insert chunks and symbols
					for (const chunk of chunks) {
						const chunkId = db.insertChunk(
							fileId,
							chunk.filePath,
							chunk.startLine,
							chunk.endLine,
							chunk.kind,
							chunk.name,
							chunk.content,
							chunk.fileType,
						);
						allNewChunkIds.push(chunkId);

						if (chunk.name) {
							db.insertSymbol(chunkId, chunk.name, chunk.kind);
						}
					}

					// Store import edges
					for (const imp of imports) {
						db.insertImport(fileId, imp);
					}
				});
			} catch (err: unknown) {
				// Re-throw database/infrastructure errors. Only source-file failures
				// are counted as skipped files so callers do not receive a misleading
				// partial-success result for a broken index.
				if (isDatabaseError(err)) throw err;
				failed++;
			}
		}

		// Phase 5: Embed new chunks unless the caller only needs structural data.
		// A later semantic search fills any missing embeddings via ensureEmbeddings().
		if (allNewChunkIds.length > 0 && options.embed !== false) {
			await this.embedChunks(db, allNewChunkIds, onProgress);
		}

		return { added: toAdd.length, updated: toUpdate.length, removed: toRemove.length, failed };
	}

	/**
	 * Ensure all chunks have embeddings, generating any missing ones.
	 */
	async ensureEmbeddings(onProgress?: IndexProgressCallback): Promise<number> {
		const db = this.getDb();
		const missingIds = db.getChunkIdsWithoutEmbedding(this.config.modelName);
		if (missingIds.length === 0) return 0;

		await this.embedChunks(db, missingIds, onProgress);
		return missingIds.length;
	}

	/**
	 * Generate embeddings for specific chunks.
	 * Requires an embedder to be set via setEmbedder() before calling.
	 */
	private async embedChunks(
		db: SearchDatabase,
		chunkIds: number[],
		onProgress?: IndexProgressCallback,
	): Promise<void> {
		if (chunkIds.length === 0) return;

		if (!this.embedder) {
			throw new Error("IndexManager: embedder not set. Call setEmbedder() before embedding.");
		}

		// Get chunk contents
		const chunks = db.getChunksById(chunkIds);
		const texts = chunks.map((c) => c.content);

		// Generate embeddings
		const vectors = await this.embedder.embedDocuments(texts, onProgress);

		// Store embeddings
		const items = chunks.map((chunk, i) => ({
			chunkId: chunk.id,
			modelName: this.config.modelName,
			vector: vectors[i],
		}));
		db.batchUpsertEmbeddings(items);
	}

	/** Check if the index exists. */
	indexExists(): boolean {
		const dbPath = path.join(this.config.indexDir, DB_FILENAME);
		return existsSync(dbPath);
	}

	/** Get index stats. */
	getStats(): { files: number; chunks: number } | null {
		if (!this.indexExists()) return null;
		const db = this.getDb();
		return {
			files: db.getFileCount(),
			chunks: db.getChunkCount(),
		};
	}
}

// ============================================================================
// Import Extraction (simple regex-based)
// ============================================================================

/**
 * Extract import targets from source code.
 * Returns resolved relative paths (without extensions for JS/TS).
 */
function extractImports(content: string, filePath: string, fileType: string): string[] {
	const imports: string[] = [];
	const dir = path.dirname(filePath);

	if (fileType === "typescript" || fileType === "tsx" || fileType === "javascript") {
		// Static imports (including side effects and multiline forms), re-exports,
		// dynamic import(), and CommonJS require().
		const importPatterns = [
			/\bimport\s+(?:type\s+)?[^;]*?\s+from\s+['"]([^'"]+)['"]/g,
			/\bimport\s*['"]([^'"]+)['"]/g,
			/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^;]*?\})\s+from\s+['"]([^'"]+)['"]/g,
			/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g,
		];
		const targets = new Set<string>();
		for (const pattern of importPatterns) {
			for (const match of content.matchAll(pattern)) {
				const target = match[1];
				if (target.startsWith(".")) targets.add(resolveImportPath(dir, target));
			}
		}
		imports.push(...targets);
	} else if (fileType === "python") {
		// from . import X, from .module import X
		const fromRe = /from\s+(\.\S*)\s+import/g;
		for (const match of content.matchAll(fromRe)) {
			const resolved = resolvePythonImport(dir, match[1]);
			if (resolved) imports.push(resolved);
		}
	} else if (fileType === "go") {
		// import "..." or import ( "..." )
		const importRe = /import\s+(?:\(\s*(?:[\s\S]*?)\s*\)|"([^"]+)")/g;
		const pathRe = /"([^"]+)"/g;
		for (const match of content.matchAll(importRe)) {
			if (match[1]) {
				imports.push(match[1]);
			} else {
				// Multi-line import block
				for (const inner of match[0].matchAll(pathRe)) {
					imports.push(inner[1]);
				}
			}
		}
	} else if (fileType === "rust") {
		// use crate::..., use super::...,
		const useRe = /use\s+((?:crate|super|self)::[\w:]+)/g;
		for (const match of content.matchAll(useRe)) {
			imports.push(match[1].replace(/::/g, "/"));
		}
	} else if (fileType === "java") {
		// import com.example.Foo;
		const importRe = /import\s+([\w.]+)\s*;/g;
		for (const match of content.matchAll(importRe)) {
			imports.push(match[1].replace(/\./g, "/"));
		}
	} else if (fileType === "c" || fileType === "cpp") {
		// #include "local.h"
		const includeRe = /#include\s+"([^"]+)"/g;
		for (const match of content.matchAll(includeRe)) {
			imports.push(path.posix.join(dir, match[1]));
		}
	}

	return imports;
}

/** Resolve a relative JS/TS import to a file path. */
function resolveImportPath(fromDir: string, importPath: string): string {
	// Strip .js/.ts extension if present (normalize)
	const cleaned = importPath.replace(/\.[jt]sx?$/, "");
	return path.posix.join(fromDir, cleaned);
}

/** Resolve a Python relative import. */
function resolvePythonImport(fromDir: string, importPath: string): string | null {
	if (importPath === ".") return fromDir;
	const dots = importPath.match(/^(\.+)/);
	if (!dots) return null;
	const levels = dots[1].length - 1;
	const remainder = importPath.slice(dots[1].length).replace(/\./g, "/");
	let base = fromDir;
	for (let i = 0; i < levels; i++) {
		base = path.posix.dirname(base);
	}
	return remainder ? path.posix.join(base, remainder) : base;
}
