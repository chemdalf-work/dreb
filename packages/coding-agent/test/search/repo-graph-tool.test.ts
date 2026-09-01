import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepoGraphToolDefinition } from "../../src/core/tools/search.js";

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

	it("fails loudly for a file outside the index", async () => {
		const root = fixture();
		await expect(execute(createRepoGraphToolDefinition(root), { file: "src/missing.ts" })).rejects.toThrow(
			/not present in the repository index/,
		);
	});
});
