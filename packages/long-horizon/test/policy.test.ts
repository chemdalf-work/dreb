import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCommandAuthorized,
	createAuthorizedCommandTool,
	getWorkspaceContext,
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
		const outside = join(dirname(config.cwd), "outside-external.txt");
		writeFileSync(outside, "external\n");
		symlinkSync(outside, join(config.cwd, "owner’s-external.txt"));
		const read = roleToolSurface("planner", config.cwd).find((tool) => tool.name === "read");
		if (!read) throw new Error("missing read tool");
		await expect(read.execute("call", { path: "owner's-external.txt" } as never)).rejects.toThrow(/symlink/);
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

		const tools = roleToolSurface("executor", config.cwd, { protectedMutationPaths: [runDir] });
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

	it("denies credential file read and mutation tools by default, while leaving ordinary files available", async () => {
		const config = testConfig();
		const credentials = join(config.cwd, ".env.production");
		const privateKey = join(config.cwd, "keys", "id_ed25519_backup");
		const ordinary = join(config.cwd, "secretary.txt");
		mkdirSync(dirname(privateKey), { recursive: true });
		writeFileSync(credentials, "TOKEN=secret\n");
		writeFileSync(privateKey, "private key\n");
		writeFileSync(ordinary, "ordinary\n");

		const denied = roleToolSurface("executor", config.cwd);
		const deniedRead = denied.find((tool) => tool.name === "read");
		const deniedGrep = denied.find((tool) => tool.name === "grep");
		const deniedEdit = denied.find((tool) => tool.name === "edit");
		const deniedWrite = denied.find((tool) => tool.name === "write");
		if (!deniedRead || !deniedGrep || !deniedEdit || !deniedWrite) throw new Error("missing executor file tools");

		await expect(deniedRead.execute("call", { path: credentials } as never)).rejects.toThrow(
			/credential access denied/,
		);
		await expect(deniedGrep.execute("call", { pattern: "TOKEN", path: credentials } as never)).rejects.toThrow(
			/credential access denied/,
		);
		await expect(
			deniedEdit.execute("call", { path: credentials, oldText: "TOKEN=secret", newText: "TOKEN=changed" } as never),
		).rejects.toThrow(/credential access denied/);
		await expect(deniedWrite.execute("call", { path: privateKey, content: "changed\n" } as never)).rejects.toThrow(
			/credential access denied/,
		);
		await expect(deniedRead.execute("call", { path: ordinary } as never)).resolves.toBeDefined();
		await expect(deniedGrep.execute("call", { pattern: "ordinary", path: ordinary } as never)).resolves.toBeDefined();

		const recursiveDenied = await deniedGrep.execute("call", { pattern: "TOKEN", path: "." } as never);
		expect(JSON.stringify(recursiveDenied)).not.toContain("TOKEN=secret");
		expect(JSON.stringify(recursiveDenied)).not.toContain(".env.production");

		const allowed = roleToolSurface("executor", config.cwd, { allowCredentials: true });
		const allowedRead = allowed.find((tool) => tool.name === "read");
		const allowedGrep = allowed.find((tool) => tool.name === "grep");
		const allowedEdit = allowed.find((tool) => tool.name === "edit");
		const allowedWrite = allowed.find((tool) => tool.name === "write");
		if (!allowedRead || !allowedGrep || !allowedEdit || !allowedWrite) throw new Error("missing executor file tools");
		await expect(allowedRead.execute("call", { path: credentials } as never)).resolves.toBeDefined();
		await expect(
			allowedGrep.execute("call", { pattern: "TOKEN", path: credentials } as never),
		).resolves.toBeDefined();
		await expect(
			allowedEdit.execute("call", { path: credentials, oldText: "TOKEN=secret", newText: "TOKEN=changed" } as never),
		).resolves.toBeDefined();
		await expect(
			allowedWrite.execute("call", { path: privateKey, content: "changed\n" } as never),
		).resolves.toBeDefined();
		expect(readFileSync(credentials, "utf8")).toContain("TOKEN=changed");
		expect(readFileSync(privateKey, "utf8")).toBe("changed\n");
	});

	it("omits both sides of a credential-sensitive staged rename from workspace context", async () => {
		const config = testConfig();
		const credentialPath = join(config.cwd, ".env.production");
		const ordinaryPath = join(config.cwd, "config.txt");
		writeFileSync(credentialPath, "TOKEN=tracked-secret\n");
		execFileSync("git", ["add", ".env.production"], { cwd: config.cwd });
		execFileSync(
			"git",
			["-c", "user.name=Dreb Test", "-c", "user.email=dreb@example.invalid", "commit", "-qm", "track credential"],
			{ cwd: config.cwd },
		);
		renameSync(credentialPath, ordinaryPath);
		execFileSync("git", ["add", "-A"], { cwd: config.cwd });

		const context = await getWorkspaceContext(config.cwd);

		expect(context.status).not.toContain(".env.production");
		expect(context.status).not.toContain("config.txt");
		expect(context.diff).not.toContain(".env.production");
		expect(context.diff).not.toContain("config.txt");
		expect(context.diff).not.toContain("TOKEN=tracked-secret");
	});

	it.each([
		"cat config/.env/production",
		"node --env-file=.env.production test.js",
		"cat deploy.credentials.json",
		"cat secrets-prod",
		"cat keys/id_ed25519_backup",
		"cat certificates/server.pem",
		"git show HEAD:.env.production",
		"git show :.env.production",
		"git show refs/heads/main:keys/id_ed25519_backup",
	] as const)("denies exact-listed credential command by default: %s", (command) => {
		const policy = { ...testConfig().policy, allowedCommands: [command] };
		expect(() => assertCommandAuthorized(command, policy)).toThrow(/credential access denied/);
		expect(() => assertCommandAuthorized(command, { ...policy, allowCredentials: true })).not.toThrow();
	});

	it("does not classify ordinary secretary filenames as credentials", () => {
		const command = "cat secretary.txt";
		expect(() =>
			assertCommandAuthorized(command, { ...testConfig().policy, allowedCommands: [command] }),
		).not.toThrow();
	});

	it("requires credential authorization before printing the GitHub auth token", () => {
		const command = "gh auth token";
		const policy = { ...testConfig().policy, allowedCommands: [command] };
		expect(() => assertCommandAuthorized(command, policy)).toThrow(/credential access/);
		expect(() => assertCommandAuthorized(command, { ...policy, allowCredentials: true })).not.toThrow();
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
		"git diff --output=workspace.patch",
		"git diff --output .git/config",
		"git reset --hard=HEAD",
		"git restore file.txt",
		"git restore --staged file.txt",
		"git restore --source HEAD file.txt",
		"git restore --source=HEAD file.txt",
		"git restore -s HEAD file.txt",
		"git restore -sHEAD file.txt",
		"git checkout -f topic",
		"git checkout --force topic",
		"git checkout -Btopic HEAD~1",
		"git checkout --orphan topic",
		"git switch -f topic",
		"git switch --discard-changes topic",
		"git switch -Ctopic HEAD~1",
		"git switch --force-create topic HEAD~1",
		"git switch --orphan topic",
		"git branch -d topic",
		"git branch -D topic",
		"git branch -f topic HEAD~1",
		"git branch --force topic HEAD~1",
		"git branch --delete --force topic",
		"git tag -d v1",
		"git tag --delete v1",
		"git tag -f v1 HEAD~1",
		"git tag --force v1 HEAD~1",
		"git update-ref refs/heads/main HEAD~1",
		"git stash clear",
		"git stash drop stash@{0}",
		"git worktree remove ../other",
		"git worktree prune",
	] as const)("classifies destructive Git operations: %s", (command) => {
		const policy = { ...testConfig().policy, allowedCommands: [command] };
		expect(() => assertCommandAuthorized(command, policy)).toThrow(/destructive git/);
		expect(() => assertCommandAuthorized(command, { ...policy, allowDestructiveGit: true })).not.toThrow();
	});

	it.each([
		"gh api repos/acme/project/issues --method POST -f title=x",
		"gh api repos/acme/project/issues -XPOST -f title=x",
		"gh api repos/acme/project/issues -f title=x",
		"gh repo create demo --public",
		"gh workflow run release.yml",
		"gh run cancel 123",
		"gh secret set TOKEN",
	] as const)("classifies remote-state mutations: %s", (command) => {
		const policy = { ...testConfig().policy, allowedCommands: [command], allowCredentials: true };
		expect(() => assertCommandAuthorized(command, policy)).toThrow(/remote-state/);
		expect(() => assertCommandAuthorized(command, { ...policy, allowRemoteState: true })).not.toThrow();
	});

	it.each([
		"git push origin main",
		"git -C . send-pack origin main",
		"git lfs push origin main",
		"git-lfs push origin main",
		"wget --post-data=x https://api.example.invalid/resource",
		"rclone copy ./artifact remote:bucket",
		`node -e 'fetch("https://api.example.invalid/resource", { method: "POST" })'`,
		`nodejs -e 'fetch("https://api.example.invalid/resource", { method: "POST" })'`,
		`python3 -c 'print("opaque command")'`,
		`python3.12 -c 'print("opaque command")'`,
		"rsync ./artifact deploy@example.invalid:/srv/releases/",
		"npm publish",
		"kubectl apply -f deployment.yml",
	] as const)("requires remote-state authorization independently: %s", (command) => {
		const policy = {
			...testConfig().policy,
			allowedCommands: [command],
			allowDestructiveGit: true,
			allowRelease: true,
			allowDeploy: true,
			allowCredentials: true,
		};
		expect(() => assertCommandAuthorized(command, policy)).toThrow(/remote-state/);
		expect(() => assertCommandAuthorized(command, { ...policy, allowRemoteState: true })).not.toThrow();
	});

	it.each([
		"kubectl create deployment app --image=nginx",
		"kubectl --profile-output get delete deployment app",
		"kubectl patch deployment app --type=merge --patch={}",
		"kubectl scale deployment app --replicas=0",
		"helm rollback app 1",
	] as const)("requires deployment and remote-state authorization independently: %s", (command) => {
		const policy = { ...testConfig().policy, allowedCommands: [command] };
		expect(() => assertCommandAuthorized(command, { ...policy, allowRemoteState: true })).toThrow(/deployment/);
		expect(() => assertCommandAuthorized(command, { ...policy, allowDeploy: true })).toThrow(/remote-state/);
		expect(() =>
			assertCommandAuthorized(command, { ...policy, allowDeploy: true, allowRemoteState: true }),
		).not.toThrow();
	});

	it("requires deployment and remote-state authorization independently for AWS deployment commands", () => {
		const command = "aws ecs update-service --cluster prod --service app --force-new-deployment";
		const policy = { ...testConfig().policy, allowedCommands: [command] };
		expect(() => assertCommandAuthorized(command, { ...policy, allowRemoteState: true })).toThrow(/deployment/);
		expect(() => assertCommandAuthorized(command, { ...policy, allowDeploy: true })).toThrow(/remote-state/);
		expect(() =>
			assertCommandAuthorized(command, { ...policy, allowDeploy: true, allowRemoteState: true }),
		).not.toThrow();
	});

	it.each([
		"git -C . status --short",
		"git diff --check",
		"git log -1 --oneline",
		"git stash list",
		"git worktree list",
		"npm --prefix pkg test",
		"kubectl --context production get pods",
		"gh --repo owner/repo pr view 9",
		"gh pr --repo owner/repo view 9",
		"gh issue list --repo owner/repo",
		"gh api repos/owner/repo",
		"gh api repos/owner/repo --method GET -f per_page=10",
	])("allows exact-listed option-bearing commands outside hazardous categories: %s", (command) => {
		const policy = { ...testConfig().policy, allowedCommands: [command] };
		expect(() => assertCommandAuthorized(command, policy)).not.toThrow();
	});

	it("returns turn-ending error evidence before calling a denied command runner", async () => {
		let calls = 0;
		const observed: unknown[] = [];
		const tool = createAuthorizedCommandTool(
			process.cwd(),
			{ ...testConfig().policy, allowedCommands: ["npm publish"] },
			(evidence) => observed.push(evidence),
			async () => {
				calls++;
				throw new Error("must not run");
			},
		);
		const result = await tool.execute("call", { command: "npm publish" }, undefined, undefined, undefined as any);
		expect(calls).toBe(0);
		expect(observed).toEqual([
			expect.objectContaining({
				outcome: "denied",
				command: "npm publish",
				reason: expect.stringContaining("release"),
			}),
		]);
		expect(result).toMatchObject({
			isError: true,
			endTurn: true,
			details: { outcome: "denied", command: "npm publish" },
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Denied") });
	});

	it("returns an uncertain outcome when workspace evidence fails after command execution", async () => {
		const config = testConfig();
		const command = `node -e 'require("node:fs").renameSync(".git", ".git-after-command")'`;
		let result: Awaited<ReturnType<typeof runAuthorizedCommand>>;
		try {
			result = await runAuthorizedCommand(command, config.cwd, {
				...config.policy,
				allowedCommands: [command],
				allowRemoteState: true,
			});
		} finally {
			renameSync(join(config.cwd, ".git-after-command"), join(config.cwd, ".git"));
		}

		expect(result).toMatchObject({
			outcome: "uncertain",
			command,
			exitCode: 0,
			reconciliationError: expect.stringContaining("git rev-parse failed"),
		});
	});

	it("ends the turn with error evidence when command finalization is uncertain", async () => {
		const config = testConfig();
		const command = "npm test";
		const observed: unknown[] = [];
		let executions = 0;
		const now = new Date().toISOString();
		const tool = createAuthorizedCommandTool(
			config.cwd,
			config.policy,
			(evidence) => observed.push(evidence),
			async () => {
				executions++;
				return {
					outcome: "uncertain" as const,
					id: "uncertain-command",
					command,
					exitCode: 0,
					stdout: "side effect completed",
					stderr: "",
					startedAt: now,
					completedAt: now,
					reconciliationError: "workspace identity failed",
				};
			},
		);

		const result = await tool.execute("call", { command }, undefined, undefined, undefined as any);

		expect(executions).toBe(1);
		expect(observed).toEqual([expect.objectContaining({ outcome: "uncertain", id: "uncertain-command" })]);
		expect(result).toMatchObject({
			isError: true,
			endTurn: true,
			details: { outcome: "uncertain", id: "uncertain-command" },
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("requires reconciliation"),
		});
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
			{ ...config.policy, allowedCommands: [command], allowRemoteState: true },
			controller.signal,
		);

		expect(result).toMatchObject({ exitCode: null, termination: "aborted" });
		expect(existsSync(marker)).toBe(false);
	});

	it("terminates an authorized process when its timeout expires", async () => {
		const policy = {
			...testConfig().policy,
			allowedCommands: ["node -e 'setInterval(() => {}, 1000)'"],
			allowRemoteState: true,
			commandTimeoutMs: 25,
		};
		const result = await runAuthorizedCommand("node -e 'setInterval(() => {}, 1000)'", process.cwd(), policy);
		expect(result.termination).toBe("timeout");
		expect(result.exitCode).not.toBe(0);
	});
});
