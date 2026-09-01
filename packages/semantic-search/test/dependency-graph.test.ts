import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchDatabase } from "../src/db.js";
import { queryDependencyGraph } from "../src/dependency-graph.js";

function addFile(db: SearchDatabase, filePath: string): number {
	return db.upsertFile(filePath, 1, "typescript");
}

describe("queryDependencyGraph", () => {
	let root: string;
	let db: SearchDatabase;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "dreb-dependency-graph-"));
		db = new SearchDatabase(path.join(root, "search.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("traverses dependencies breadth-first and resolves extensionless imports", () => {
		const api = addFile(db, "src/api.ts");
		const service = addFile(db, "src/service.ts");
		addFile(db, "src/db/index.ts");
		db.insertImport(api, "src/service");
		db.insertImport(service, "src/db");

		expect(queryDependencyGraph(db, "./src/api.ts", { direction: "dependencies", depth: 2 })).toEqual({
			root: "src/api.ts",
			nodes: [
				{ filePath: "src/service.ts", depth: 1, via: "src/api.ts", relationship: "imports" },
				{ filePath: "src/db/index.ts", depth: 2, via: "src/service.ts", relationship: "imports" },
			],
			truncated: false,
		});
	});

	it("resolves extensionless imports to declaration files", () => {
		const api = addFile(db, "src/api.ts");
		addFile(db, "src/types.d.ts");
		db.insertImport(api, "src/types");

		const result = queryDependencyGraph(db, "src/api.ts", { direction: "dependencies" });
		expect(result.nodes.map((node) => node.filePath)).toEqual(["src/types.d.ts"]);
	});

	it("traverses dependents and avoids cycles", () => {
		const api = addFile(db, "src/api.ts");
		const service = addFile(db, "src/service.ts");
		const route = addFile(db, "src/route.ts");
		db.insertImport(api, "src/service");
		db.insertImport(route, "src/api");
		db.insertImport(service, "src/route");

		const result = queryDependencyGraph(db, "src/service.ts", { direction: "dependents", depth: 3 });
		expect(result.nodes.map((node) => node.filePath)).toEqual(["src/api.ts", "src/route.ts"]);
		expect(result.nodes.every((node) => node.relationship === "imported_by")).toBe(true);
	});

	it("caps output and reports truncation", () => {
		const rootFile = addFile(db, "src/root.ts");
		for (const name of ["a", "b", "c"]) {
			addFile(db, `src/${name}.ts`);
			db.insertImport(rootFile, `src/${name}`);
		}

		const result = queryDependencyGraph(db, "src/root.ts", { direction: "dependencies", limit: 2 });
		expect(result.nodes).toHaveLength(2);
		expect(result.truncated).toBe(true);
	});

	it("fails loudly when the requested file is not indexed", () => {
		addFile(db, "src/root.ts");
		expect(() => queryDependencyGraph(db, "src/missing.ts")).toThrow(/not present in the repository index/);
	});
});
