import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CommandEvidence,
	HostedSession,
	LongHorizonRunConfig,
	PromptResult,
	SessionHost,
	SessionReference,
	SessionRole,
} from "../src/index.js";
import { normalizeRunConfig } from "../src/index.js";

export function testConfig(overrides: Partial<LongHorizonRunConfig> = {}): LongHorizonRunConfig {
	const base = mkdtempSync(join(tmpdir(), "dreb-long-horizon-"));
	const cwd = join(base, "workspace");
	mkdirSync(cwd);
	writeFileSync(join(cwd, "file.txt"), "initial\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "file.txt"], { cwd });
	execFileSync(
		"git",
		["-c", "user.name=Dreb Test", "-c", "user.email=dreb@example.invalid", "commit", "-qm", "initial"],
		{
			cwd,
		},
	);
	const normalized = normalizeRunConfig({
		objective: "finish the test objective",
		cwd,
		runRoot: join(base, "runs"),
		planner: { provider: "test", modelId: "sol", thinkingLevel: "max" },
		executor: { provider: "test", modelId: "terra", thinkingLevel: "high" },
		advisor: { provider: "test", modelId: "sol", thinkingLevel: "max" },
		acceptanceCommands: ["npm test"],
		policy: { allowedCommands: ["npm test", "git status --short"] },
	});
	return { ...normalized, ...overrides };
}

export function promptResult(text: string, overrides: Partial<PromptResult> = {}): PromptResult {
	return {
		text,
		events: [],
		toolEvidence: [],
		commandEvidence: [],
		askUserObserved: false,
		tokens: 100,
		costUsd: 0.01,
		context: { tokens: 1000, contextWindow: 400_000 },
		...overrides,
	};
}

export class FakeSessionHost implements SessionHost {
	readonly created: SessionReference[] = [];
	readonly prompts: Array<{ sessionId: string; text: string }> = [];
	readonly aborted: string[] = [];
	private nextId = 0;

	constructor(private readonly responses: Partial<Record<SessionRole, PromptResult[]>>) {}

	async create(
		role: SessionRole,
		selection: LongHorizonRunConfig["planner"],
		parentFile?: string,
	): Promise<HostedSession> {
		const id = `${role}-${++this.nextId}`;
		const reference: SessionReference = {
			id,
			role,
			file: `/fake/${id}.jsonl`,
			parentFile,
			provider: selection.provider,
			modelId: selection.modelId,
			thinkingLevel: selection.thinkingLevel,
			createdAt: new Date().toISOString(),
		};
		this.created.push(reference);
		return this.hosted(reference);
	}

	async open(reference: SessionReference): Promise<HostedSession> {
		return this.hosted(reference);
	}

	private hosted(reference: SessionReference): HostedSession {
		return {
			reference,
			prompt: async (text) => {
				this.prompts.push({ sessionId: reference.id, text });
				const result = this.responses[reference.role]?.shift();
				if (!result) throw new Error(`no fake ${reference.role} response`);
				return result;
			},
			abort: async () => {
				this.aborted.push(reference.id);
			},
			dispose: () => undefined,
		};
	}
}

export function commandEvidence(command: string, workspaceIdentity: string, exitCode = 0): CommandEvidence {
	const now = new Date().toISOString();
	return {
		id: `command-${Math.random()}`,
		command,
		exitCode,
		stdout: "ok",
		stderr: "",
		startedAt: now,
		completedAt: now,
		workspaceIdentity,
	};
}

export const PLAN = `<dreb-plan>{"schemaVersion":1,"objective":"finish the test objective","workUnits":[{"id":"unit","title":"work","acceptance":["tests"]}],"acceptanceCriteria":["tests pass"],"constraints":[]}</dreb-plan>`;

export function report(status: "progress" | "failed" | "blocked" | "complete" | "handoff_ready", extra = ""): string {
	return `<dreb-report>{"schemaVersion":1,"status":"${status}","workUnitId":"unit","strategyId":"strategy-a","progress":"did work","evidenceIds":[],${extra}"handoffReady":${status === "handoff_ready"},"nextAction":"continue"}</dreb-report>`;
}
