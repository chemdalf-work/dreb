import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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

	it("denies executor mutations of Git and active supervisor storage", async () => {
		const config = testConfig();
		const runDir = join(config.cwd, ".dreb", "long-runs", config.runId);
		mkdirSync(runDir, { recursive: true });
		const journal = join(runDir, "journal.jsonl");
		writeFileSync(journal, "durable\n");
		const gitConfig = join(config.cwd, ".git", "config");
		const gitConfigBefore = readFileSync(gitConfig, "utf8");
		const gitAlias = join(config.cwd, "git-control");
		symlinkSync(join(config.cwd, ".git"), gitAlias, "dir");
		const hardLinkedGitConfig = join(config.cwd, "git-config-link");
		const hardLinkedJournal = join(config.cwd, "journal-link");
		linkSync(gitConfig, hardLinkedGitConfig);
		linkSync(journal, hardLinkedJournal);

		const tools = roleToolSurface("executor", config.cwd, [runDir]);
		const edit = tools.find((tool) => tool.name === "edit");
		const write = tools.find((tool) => tool.name === "write");
		if (!edit || !write) throw new Error("missing executor mutation tools");

		for (const target of [gitConfig, join(gitAlias, "config"), hardLinkedGitConfig, journal, hardLinkedJournal]) {
			await expect(write.execute("call", { path: target, content: "corrupt\n" } as never)).rejects.toThrow(
				/protected control-plane path/,
			);
			await expect(
				edit.execute("call", { path: target, oldText: "durable", newText: "corrupt" } as never),
			).rejects.toThrow(/protected control-plane path/);
		}
		expect(readFileSync(gitConfig, "utf8")).toBe(gitConfigBefore);
		expect(readFileSync(journal, "utf8")).toBe("durable\n");
	});

	it("protects the actual Git directory referenced by a gitdir file", async () => {
		const config = testConfig();
		const dotGit = join(config.cwd, ".git");
		const actualGitDir = join(config.cwd, ".git-data");
		renameSync(dotGit, actualGitDir);
		writeFileSync(dotGit, "gitdir: .git-data\n");
		const gitConfig = join(actualGitDir, "config");
		const before = readFileSync(gitConfig, "utf8");
		const write = roleToolSurface("executor", config.cwd).find((tool) => tool.name === "write");
		if (!write) throw new Error("missing executor write tool");

		await expect(write.execute("call", { path: gitConfig, content: "corrupt\n" } as never)).rejects.toThrow(
			/protected control-plane path/,
		);
		expect(readFileSync(gitConfig, "utf8")).toBe(before);
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

	it.each([
		["git -C . push origin main", /destructive git/],
		["npm --prefix pkg publish", /release/],
		["kubectl --context production delete deployment app", /deployment/],
		["gh --repo owner/repo pr comment 9 --body approved", /remote-state/],
		[`curl --data '{"state":"closed"}' https://api.example.invalid/resource`, /remote-state/],
	] as const)("does not let executable-global options bypass category policy: %s", (command, category) => {
		const policy = { ...testConfig().policy, allowedCommands: [command] };
		expect(() => assertCommandAuthorized(command, policy)).toThrow(category);
	});

	it.each([
		"git -C . status --short",
		"npm --prefix pkg test",
		"kubectl --context production get pods",
		"gh --repo owner/repo pr view 9",
	])("allows exact-listed option-bearing commands outside hazardous categories: %s", (command) => {
		const policy = { ...testConfig().policy, allowedCommands: [command] };
		expect(() => assertCommandAuthorized(command, policy)).not.toThrow();
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
