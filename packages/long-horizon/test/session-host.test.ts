import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Model } from "@dreb/ai";
import type { AgentSession, ModelRegistry } from "@dreb/coding-agent";
import { describe, expect, it, vi } from "vitest";

// The long-horizon package normally imports the compiled workspace package. Exercise
// the source SDK here so this test covers the supplied tool implementations before
// the parent build refreshes package dist output.
vi.mock("@dreb/coding-agent", async () => import("../../coding-agent/src/index.js"));

import { DrebSessionHost, type HostedSession } from "../src/session-host.js";
import { testConfig } from "./helpers.js";

function model(): Model<any> {
	return {
		provider: "test",
		id: "gpt-5.6-test",
		name: "Test model",
		api: "anthropic-messages",
		input: ["text"],
		reasoning: true,
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as Model<any>;
}

function registry(testModel: Model<any>): ModelRegistry {
	return {
		find: (provider: string, modelId: string) =>
			provider === testModel.provider && modelId === testModel.id ? testModel : undefined,
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		getModelPromptSettings: () => undefined,
		isUsingOAuth: () => false,
	} as unknown as ModelRegistry;
}

function runtimeSession(hosted: HostedSession): AgentSession {
	return (hosted as unknown as { session: AgentSession }).session;
}

async function executeRuntimeTool(
	session: AgentSession,
	name: string,
	params: Record<string, string>,
): Promise<unknown> {
	const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`missing active ${name} tool`);
	return tool.execute("runtime-call", params, new AbortController().signal, () => undefined);
}

describe("DrebSessionHost runtime tool confinement", () => {
	it("uses the confined tool surface in planner and executor AgentSessions", async () => {
		const initial = testConfig();
		const config = {
			...initial,
			runRoot: join(initial.cwd, ".dreb", "long-runs"),
			planner: { provider: "test", modelId: "gpt-5.6-test", thinkingLevel: "high" as const },
			executor: { provider: "test", modelId: "gpt-5.6-test", thinkingLevel: "high" as const },
			advisor: { provider: "test", modelId: "gpt-5.6-test", thinkingLevel: "high" as const },
		};
		const outside = join(dirname(config.cwd), "outside.txt");
		const credentials = join(config.cwd, ".env.production");
		const activeRunPath = resolve(config.runRoot, config.runId, "journal.jsonl");
		mkdirSync(dirname(activeRunPath), { recursive: true });
		writeFileSync(outside, "outside\n");
		writeFileSync(credentials, "TOKEN=secret\n");
		writeFileSync(activeRunPath, "durable\n");

		const host = new DrebSessionHost(config, { modelRegistry: registry(model()) });
		const planner = await host.create("planner", config.planner);
		const executor = await host.create("executor", config.executor);
		try {
			await expect(executeRuntimeTool(runtimeSession(planner), "read", { path: outside })).rejects.toThrow(
				/escapes configured workspace/,
			);
			await expect(
				executeRuntimeTool(runtimeSession(planner), "grep", { pattern: "TOKEN", path: credentials }),
			).rejects.toThrow(/credential access denied/);
			await expect(
				executeRuntimeTool(runtimeSession(executor), "write", { path: outside, content: "changed\n" }),
			).rejects.toThrow(/escapes configured workspace/);
			await expect(
				executeRuntimeTool(runtimeSession(executor), "write", {
					path: join(config.cwd, ".git", "config"),
					content: "changed\n",
				}),
			).rejects.toThrow(/protected control-plane path/);
			await expect(
				executeRuntimeTool(runtimeSession(executor), "write", { path: activeRunPath, content: "changed\n" }),
			).rejects.toThrow(/protected control-plane path/);
		} finally {
			planner.dispose();
			executor.dispose();
		}
	});
});
