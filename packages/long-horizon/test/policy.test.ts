import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

	it("rejects absolute paths outside the configured workspace for every role file tool", async () => {
		const config = testConfig();
		const outside = join(dirname(config.cwd), "outside.txt");
		writeFileSync(outside, "secret\n");
		for (const role of ["planner", "executor"] as const) {
			for (const tool of roleToolSurface(role, config.cwd)) {
				const params =
					tool.name === "grep"
						? { pattern: "secret", path: outside }
						: tool.name === "find"
							? { pattern: "*", path: outside }
							: tool.name === "edit"
								? { path: outside, oldText: "secret", newText: "changed" }
								: tool.name === "write"
									? { path: outside, content: "changed" }
									: { path: outside };
				await expect(tool.execute("call", params as never)).rejects.toThrow(/escapes configured workspace/);
			}
		}
		const read = roleToolSurface("planner", config.cwd).find((tool) => tool.name === "read");
		if (!read) throw new Error("missing read tool");
		for (const disguised of [`@${outside}`, `"${outside}"`]) {
			await expect(read.execute("call", { path: disguised } as never)).rejects.toThrow(
				/escapes configured workspace/,
			);
		}
	});

	it("rejects read fallback to an external symlink with a normalized filename", async () => {
		const config = testConfig();
		const outside = join(dirname(config.cwd), "outside-secret.txt");
		writeFileSync(outside, "secret\n");
		symlinkSync(outside, join(config.cwd, "owner’s-secret.txt"));
		const read = roleToolSurface("planner", config.cwd).find((tool) => tool.name === "read");
		if (!read) throw new Error("missing read tool");
		await expect(read.execute("call", { path: "owner's-secret.txt" } as never)).rejects.toThrow(/symlink/);
	});

	it("rejects writes through a workspace symlink to an outside directory", async () => {
		const config = testConfig();
		const outsideDir = dirname(config.cwd);
		const link = join(config.cwd, "escape");
		symlinkSync(outsideDir, link, "dir");
		const target = join(link, "created-outside.txt");
		const write = roleToolSurface("executor", config.cwd).find((tool) => tool.name === "write");
		if (!write) throw new Error("missing write tool");
		await expect(write.execute("call", { path: target, content: "escaped" } as never)).rejects.toThrow(/symlink/);
		expect(existsSync(join(outsideDir, "created-outside.txt"))).toBe(false);
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

	it("does not spawn an authorized process when its signal is already aborted", async () => {
		const config = testConfig();
		const marker = join(config.cwd, "spawned.txt");
		const command = `node -e 'require("node:fs").writeFileSync("spawned.txt", "yes")'`;
		const controller = new AbortController();
		controller.abort();

		const result = await runAuthorizedCommand(
			command,
			config.cwd,
			{ ...config.policy, allowedCommands: [command] },
			controller.signal,
		);

		expect(result).toMatchObject({ exitCode: null, termination: "aborted" });
		expect(existsSync(marker)).toBe(false);
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
