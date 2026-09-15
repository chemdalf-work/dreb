import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	discoverSessionFile,
	getBackgroundAgents,
	pruneBackgroundAgents,
	rehydrateBackgroundAgentsFromDisk,
} from "../src/core/tools/subagent.js";

function createTempDir(): string {
	const dir = join(tmpdir(), `dreb-test-subagent-rehydrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeJsonl(filePath: string, entries: unknown[]): void {
	writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("rehydrateBackgroundAgentsFromDisk", () => {
	let tempDir: string;
	let subagentSessionsBase: string;
	let parentSessionFile: string;

	beforeEach(() => {
		tempDir = createTempDir();
		subagentSessionsBase = join(tempDir, "subagent-sessions");
		mkdirSync(subagentSessionsBase, { recursive: true });
		parentSessionFile = join(tempDir, "2026-01-02T03-04-05-000Z_parent-session.jsonl");
		writeJsonl(parentSessionFile, [
			{
				type: "session",
				version: 3,
				id: "parent-session-id",
				timestamp: "2026-01-02T03:04:05.000Z",
				cwd: tempDir,
			},
		]);
	});

	afterEach(() => {
		pruneBackgroundAgents(0);
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("registers a matching child session with disk log paths and completed status", () => {
		const childDir = join(subagentSessionsBase, "child-completed");
		mkdirSync(childDir, { recursive: true });
		const childSessionFile = join(childDir, "child.jsonl");
		writeJsonl(childSessionFile, [
			{
				type: "session",
				version: 3,
				id: "child-completed",
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				parentSession: parentSessionFile,
				agentType: "Review",
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-02T03:05:01.000Z",
				message: { role: "user", content: "Investigate the resumed dashboard subagent chip" },
			},
			{
				type: "thinking_level_change",
				id: "thinking-1",
				parentId: "user-1",
				timestamp: "2026-01-02T03:05:01.500Z",
				thinkingLevel: "high",
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "thinking-1",
				timestamp: "2026-01-02T03:05:02.000Z",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet",
					content: [{ type: "text", text: "Done" }],
					usage: {
						input: 100,
						output: 20,
						cacheRead: 30,
						cacheWrite: 4,
						cost: { total: 0.125 },
					},
					stopReason: "stop",
				},
			},
		]);

		const count = rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase);

		expect(count).toBe(1);
		const agent = getBackgroundAgents().find((candidate) => candidate.sessionFile === childSessionFile);
		expect(agent).toBeDefined();
		expect(agent).toMatchObject({
			agentId: "rehydrated-child-completed",
			agentType: "Review",
			taskSummary: "Investigate the resumed dashboard subagent chip",
			status: "completed",
			parentSessionId: "parent-session-id",
			provider: "anthropic",
			model: "claude-sonnet",
			thinking: "high",
			usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, cost: 0.125 },
			sessionDir: childDir,
			sessionFile: childSessionFile,
			cwd: tempDir,
		});
	});

	test("rehydrates nested descendants with stable parent identity", () => {
		const childDir = join(subagentSessionsBase, "child-parent");
		const grandchildDir = join(subagentSessionsBase, "child-grandchild");
		mkdirSync(childDir, { recursive: true });
		mkdirSync(grandchildDir, { recursive: true });
		const childFile = join(childDir, "child.jsonl");
		const grandchildFile = join(grandchildDir, "grandchild.jsonl");
		writeJsonl(childFile, [
			{
				type: "session",
				version: 4,
				id: "child-session-id",
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				parentSession: parentSessionFile,
				agentType: "Explore",
			},
		]);
		writeJsonl(grandchildFile, [
			{
				type: "session",
				version: 4,
				id: "grandchild-session-id",
				timestamp: "2026-01-02T03:06:00.000Z",
				cwd: tempDir,
				parentSession: childFile,
				agentType: "test-reviewer",
			},
		]);

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(2);
		const agents = getBackgroundAgents();
		expect(agents.find((agent) => agent.agentId === "rehydrated-child-grandchild")).toMatchObject({
			parentAgentId: "rehydrated-child-parent",
			parentSessionId: "child-session-id",
			agentType: "test-reviewer",
		});
	});

	test("registers a chain session from step subdirectories and uses the last step status", () => {
		const chainDir = join(subagentSessionsBase, "chain-abc123");
		const step1Dir = join(chainDir, "step-1");
		const step2Dir = join(chainDir, "step-2");
		mkdirSync(step1Dir, { recursive: true });
		mkdirSync(step2Dir, { recursive: true });
		const step1SessionFile = join(step1Dir, "step-1.jsonl");
		const step2SessionFile = join(step2Dir, "step-2.jsonl");
		writeJsonl(step1SessionFile, [
			{
				type: "session",
				version: 3,
				id: "chain-abc123-step-1",
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				parentSession: parentSessionFile,
				agentType: "Explore",
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-01-02T03:05:01.000Z",
				message: { role: "user", content: "Run chain step one" },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-01-02T03:05:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Step one done" }], stopReason: "stop" },
			},
		]);
		writeJsonl(step2SessionFile, [
			{
				type: "session",
				version: 3,
				id: "chain-abc123-step-2",
				timestamp: "2026-01-02T03:06:00.000Z",
				cwd: tempDir,
				parentSession: parentSessionFile,
				agentType: "Review",
			},
			{
				type: "message",
				id: "assistant-2",
				parentId: null,
				timestamp: "2026-01-02T03:06:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Step two failed" }], stopReason: "error" },
			},
		]);

		expect(discoverSessionFile(chainDir, "chain-abc123")).toBeDefined();

		const count = rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase);

		expect(count).toBe(1);
		const agent = getBackgroundAgents().find((candidate) => candidate.sessionDir === chainDir);
		expect(agent).toBeDefined();
		expect(agent).toMatchObject({
			agentId: "rehydrated-chain-abc123",
			agentType: "Explore",
			taskSummary: "Run chain step one",
			status: "failed",
			sessionDir: chainDir,
			sessionFile: step1SessionFile,
			cwd: tempDir,
		});
	});

	test("ignores child sessions whose parentSession does not match", () => {
		const childDir = join(subagentSessionsBase, "child-other-parent");
		mkdirSync(childDir, { recursive: true });
		const childSessionFile = join(childDir, "child.jsonl");
		writeJsonl(childSessionFile, [
			{
				type: "session",
				version: 3,
				id: "child-other-parent",
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				parentSession: join(tempDir, "different-parent.jsonl"),
				agentType: "Review",
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: "2026-01-02T03:05:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
			},
		]);

		const count = rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase);

		expect(count).toBe(0);
		expect(getBackgroundAgents().some((candidate) => candidate.sessionFile === childSessionFile)).toBe(false);
	});

	test("is idempotent and exposes the rehydrated entry through getBackgroundAgents", () => {
		const childDir = join(subagentSessionsBase, "child-idempotent");
		mkdirSync(childDir, { recursive: true });
		const childSessionFile = join(childDir, "child.jsonl");
		writeJsonl(childSessionFile, [
			{
				type: "session",
				version: 3,
				id: "child-idempotent",
				timestamp: "2026-01-02T03:05:00.000Z",
				cwd: tempDir,
				parentSession: parentSessionFile,
				agentType: "Explore",
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: "2026-01-02T03:05:02.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
			},
		]);

		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(1);
		expect(rehydrateBackgroundAgentsFromDisk(parentSessionFile, subagentSessionsBase)).toBe(0);

		const matchingAgents = getBackgroundAgents().filter((candidate) => candidate.sessionFile === childSessionFile);
		expect(matchingAgents).toHaveLength(1);
		expect(matchingAgents[0]).toMatchObject({
			agentId: "rehydrated-child-idempotent",
			agentType: "Explore",
			status: "completed",
			sessionDir: childDir,
			sessionFile: childSessionFile,
		});
	});
});
