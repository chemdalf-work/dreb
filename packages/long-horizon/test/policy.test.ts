import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCommandAuthorized,
	createAuthorizedCommandTool,
	getWorkspaceIdentity,
	roleToolSurface,
	runAuthorizedCommand,
} from "../src/policy.js";
import { testConfig } from "./helpers.js";

describe("tool policy", () => {
	it("gives read roles no mutation or unrestricted shell tools", () => {
		expect(roleToolSurface("planner", process.cwd()).map((tool) => tool.name)).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
		expect(roleToolSurface("executor", process.cwd()).map((tool) => tool.name)).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"edit",
			"write",
		]);
	});

	it("default-denies commands outside the exact allowlist and hazardous categories", () => {
		const policy = testConfig().policy;
		expect(() => assertCommandAuthorized("rm -rf /", policy)).toThrow(/explicitly authorized/);
		expect(() => assertCommandAuthorized("npm publish", { ...policy, allowedCommands: ["npm publish"] })).toThrow(
			/release/,
		);
		expect(() =>
			assertCommandAuthorized("git push origin main", { ...policy, allowedCommands: ["git push origin main"] }),
		).toThrow(/destructive git/);
		expect(() => assertCommandAuthorized("npm test; rm -rf /", policy)).toThrow(/shell operators/);
		expect(() => assertCommandAuthorized("npm test -- --watch", policy)).toThrow(/explicitly authorized/);
		expect(() => assertCommandAuthorized("npm test", policy)).not.toThrow();
	});

	it("enforces policy before calling an injected command runner", async () => {
		let calls = 0;
		const tool = createAuthorizedCommandTool(
			process.cwd(),
			testConfig().policy,
			() => undefined,
			async () => {
				calls++;
				throw new Error("must not run");
			},
		);
		const result = await tool.execute("call", { command: "npm publish" }, undefined, undefined, undefined as any);
		expect(calls).toBe(0);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Denied") });
	});

	it("includes untracked file contents in workspace identity", async () => {
		const config = testConfig();
		const path = join(config.cwd, "untracked.txt");
		writeFileSync(path, "first\n");
		const first = await getWorkspaceIdentity(config.cwd);
		writeFileSync(path, "second\n");
		const second = await getWorkspaceIdentity(config.cwd);
		expect(second).not.toBe(first);
	});

	it("terminates an authorized process when its timeout expires", async () => {
		const policy = {
			...testConfig().policy,
			allowedCommands: ["node -e 'setInterval(() => {}, 1000)'"],
			commandTimeoutMs: 25,
		};
		const result = await runAuthorizedCommand("node -e 'setInterval(() => {}, 1000)'", process.cwd(), policy);
		expect(result.termination).toBe("timeout");
		expect(result.exitCode).not.toBe(0);
	});
});
