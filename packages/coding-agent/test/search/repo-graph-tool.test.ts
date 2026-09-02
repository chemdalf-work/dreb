import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRepoGraphToolDefinition,
	prepareRepoGraphIndex,
	resolveDefaultSearchDir,
} from "../../src/core/tools/search.js";

const roots: string[] = [];

function fixture(): string {
	const root = mkdtempSync(path.join(tmpdir(), "dreb-repo-graph-tool-"));
	roots.push(root);
	mkdirSync(path.join(root, "src"), { recursive: true });
	writeFileSync(
		path.join(root, "src", "api.ts"),
		'import { service } from "./service";\nexport const api = service;\n',
	);
	writeFileSync(path.join(root, "src", "service.ts"), "export const service = true;\n");
	writeFileSync(path.join(root, "src", "route.ts"), 'import { api } from "./api";\nexport const route = api;\n');
	return root;
}

function mutualImportFixture(): string {
	const root = mkdtempSync(path.join(tmpdir(), "dreb-repo-graph-tool-cycle-"));
	roots.push(root);
	mkdirSync(path.join(root, "src"), { recursive: true });
	writeFileSync(path.join(root, "src", "a.ts"), 'import "./b";\n');
	writeFileSync(path.join(root, "src", "b.ts"), 'import "./a";\n');
	return root;
}

async function execute(tool: ReturnType<typeof createRepoGraphToolDefinition>, params: Record<string, unknown>) {
	return tool.execute("call-1", params as any, undefined, undefined, {} as any);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createRepoGraphToolDefinition", () => {
	it("registers a bounded structural graph schema", () => {
		const tool = createRepoGraphToolDefinition(fixture());
		const schema = tool.parameters as any;
		expect(tool.name).toBe("repo_graph");
		expect(schema.required).toContain("file");
		expect(schema.properties.direction.enum).toEqual(["dependencies", "dependents", "both"]);
		expect(schema.properties.depth.maximum).toBe(3);
		expect(schema.properties.limit.maximum).toBe(100);
	});

	it("returns dependencies from the shared local index with a runtime-evidence warning", async () => {
		const root = fixture();
		const result = await execute(createRepoGraphToolDefinition(root), {
			file: "src/api.ts",
			direction: "dependencies",
			depth: 1,
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("src/service.ts");
		expect(text).toContain("Static import evidence only");
		expect(result.details).toMatchObject({ root: "src/api.ts", resultCount: 1, truncated: false });
	});

	it("returns dependents in the opposite direction", async () => {
		const root = fixture();
		const result = await execute(createRepoGraphToolDefinition(root), {
			file: "src/api.ts",
			direction: "dependents",
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("src/route.ts");
		expect(text).toContain("[imported_by]");
	});

	it("renders mutual imports once with both relationships", async () => {
		const root = mutualImportFixture();
		const result = await execute(createRepoGraphToolDefinition(root), {
			file: "src/a.ts",
			direction: "both",
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("[imports_and_imported_by] src/b.ts");
		expect(text.match(/src\/b\.ts/g)).toHaveLength(1);
		expect(result.details).toMatchObject({ resultCount: 1, truncated: false });
	});

	it("prepares the graph at the Git root when launched from a nested directory", async () => {
		const root = fixture();
		execFileSync("git", ["init", "-q"], { cwd: root });
		const nested = path.join(root, "src", "nested");
		mkdirSync(nested);

		const prepared = await prepareRepoGraphIndex(nested);

		expect(prepared?.projectRoot).toBe(realpathSync(root));
		await expect(resolveDefaultSearchDir(nested)).resolves.toBe(prepared?.projectRoot);
		expect(prepared?.indexStats?.files).toBeGreaterThanOrEqual(3);
		expect(prepared?.failed).toBe(0);
		expect(existsSync(path.join(root, ".dreb", "index", "search.db"))).toBe(true);
		expect(existsSync(path.join(nested, ".dreb", "index", "search.db"))).toBe(false);

		const result = await execute(createRepoGraphToolDefinition(nested), {
			file: "src/api.ts",
			direction: "dependencies",
		});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("src/service.ts");
	});

	it("does not create an index outside a Git repository", async () => {
		const root = fixture();

		await expect(prepareRepoGraphIndex(root)).resolves.toBeNull();
		expect(existsSync(path.join(root, ".dreb", "index"))).toBe(false);
	});

	it("rejects an arbitrary .git marker that Git does not recognize", async () => {
		const root = fixture();
		mkdirSync(path.join(root, ".git"));

		await expect(prepareRepoGraphIndex(root)).resolves.toBeNull();
		expect(existsSync(path.join(root, ".dreb", "index"))).toBe(false);
	});

	it("fails loudly for a file outside the index", async () => {
		const root = fixture();
		await expect(execute(createRepoGraphToolDefinition(root), { file: "src/missing.ts" })).rejects.toThrow(
			/not present in the repository index/,
		);
	});
});
