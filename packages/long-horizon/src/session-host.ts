import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Model } from "@dreb/ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@dreb/coding-agent";
import { validateThinkingCapability } from "./config.js";
import { type CommandRunner, createAuthorizedCommandTool, roleToolSurface } from "./policy.js";
import type {
	CommandEvidence,
	LongHorizonRunConfig,
	ModelSelection,
	SessionReference,
	SessionRole,
	ToolEvidence,
} from "./types.js";

export interface PromptResult {
	text: string;
	events: Array<{ timestamp: string; event: unknown }>;
	toolEvidence: ToolEvidence[];
	commandEvidence: CommandEvidence[];
	askUserObserved: boolean;
	tokens: number;
	costUsd: number;
	context?: { tokens: number; contextWindow: number };
}

export interface HostedSession {
	readonly reference: SessionReference;
	prompt(text: string): Promise<PromptResult>;
	abort(): Promise<void>;
	dispose(): void;
}

export interface SessionHost {
	validate?(): Promise<void>;
	create(role: SessionRole, selection: ModelSelection, parentFile?: string): Promise<HostedSession>;
	open(reference: SessionReference, selection: ModelSelection): Promise<HostedSession>;
}

interface Capture {
	startedAt: string;
	toolName: string;
	args: unknown;
}

function jsonSafe(value: unknown): unknown {
	try {
		const serialized = JSON.stringify(value);
		if (serialized.length <= 16 * 1024) return JSON.parse(serialized);
		return { truncated: true, preview: serialized.slice(0, 16 * 1024) };
	} catch {
		return String(value).slice(0, 16 * 1024);
	}
}

function assistantText(session: AgentSession, firstNewMessage: number): string {
	for (let index = session.state.messages.length - 1; index >= firstNewMessage; index--) {
		const message = session.state.messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
	}
	throw new Error("session completed without a new assistant response");
}

class DrebHostedSession implements HostedSession {
	private captures = new Map<string, Capture>();
	private events: Array<{ timestamp: string; event: unknown }> = [];
	private evidence: ToolEvidence[] = [];
	private commandEvidence: CommandEvidence[] = [];
	private askUserObserved = false;
	private unsubscribe: () => void;

	constructor(
		private readonly session: AgentSession,
		readonly reference: SessionReference,
	) {
		this.unsubscribe = session.subscribe((event) => this.capture(event));
	}

	private capture(event: AgentSessionEvent): void {
		if (this.events.length < 200) {
			this.events.push({ timestamp: new Date().toISOString(), event: jsonSafe(event) });
		}
		if (event.type === "tool_execution_start") {
			this.captures.set(event.toolCallId, {
				startedAt: new Date().toISOString(),
				toolName: event.toolName,
				args: jsonSafe(event.args),
			});
			if (event.toolName === "ask_user") this.askUserObserved = true;
		} else if (event.type === "tool_execution_end") {
			const capture = this.captures.get(event.toolCallId);
			this.evidence.push({
				id: event.toolCallId,
				toolName: event.toolName,
				startedAt: capture?.startedAt ?? new Date().toISOString(),
				completedAt: new Date().toISOString(),
				args: capture?.args,
				result: jsonSafe(event.result),
				isError: event.isError,
			});
			this.captures.delete(event.toolCallId);
		}
	}

	addCommandEvidence(evidence: CommandEvidence): void {
		this.commandEvidence.push(evidence);
	}

	async prompt(text: string): Promise<PromptResult> {
		const before = this.session.getSessionStats();
		const firstNewMessage = this.session.state.messages.length;
		this.events = [];
		this.evidence = [];
		this.commandEvidence = [];
		this.askUserObserved = false;
		await this.session.prompt(text, { expandPromptTemplates: false, source: "rpc" });
		if (this.session.isStreaming) throw new Error("session prompt returned before reaching an idle edge");
		const after = this.session.getSessionStats();
		const context = this.session.getContextUsage();
		return {
			text: assistantText(this.session, firstNewMessage),
			events: [...this.events],
			toolEvidence: [...this.evidence],
			commandEvidence: [...this.commandEvidence],
			askUserObserved: this.askUserObserved,
			tokens: Math.max(0, after.tokens.total - before.tokens.total),
			costUsd: Math.max(0, after.cost - before.cost),
			context:
				context?.tokens === null || context === undefined
					? undefined
					: { tokens: context.tokens, contextWindow: context.contextWindow },
		};
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	dispose(): void {
		this.unsubscribe();
		this.session.dispose();
	}
}

export interface DrebSessionHostOptions {
	modelRegistry?: ModelRegistry;
	authStorage?: AuthStorage;
	commandRunner?: CommandRunner;
}

export class DrebSessionHost implements SessionHost {
	private readonly modelRegistry: ModelRegistry;

	constructor(
		private readonly config: LongHorizonRunConfig,
		private readonly options: DrebSessionHostOptions = {},
	) {
		const authStorage = options.authStorage ?? AuthStorage.create();
		this.modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
		mkdirSync(this.config.runRoot, { recursive: true });
	}

	async validate(): Promise<void> {
		const selections = [this.config.planner, this.config.executor, this.config.advisor, this.config.verifier].filter(
			(selection): selection is ModelSelection => selection !== undefined,
		);
		for (const selection of selections) {
			const model = this.resolveModel(selection);
			if (!(await this.modelRegistry.getApiKey(model))) {
				throw new Error(`no API key is available for ${selection.provider}/${selection.modelId}`);
			}
		}
	}

	private resolveModel(selection: ModelSelection): Model<any> {
		const model = this.modelRegistry.find(selection.provider, selection.modelId);
		if (!model) throw new Error(`model not found: ${selection.provider}/${selection.modelId}`);
		validateThinkingCapability(selection, model);
		return model;
	}

	async create(role: SessionRole, selection: ModelSelection, parentFile?: string): Promise<HostedSession> {
		const sessionManager = SessionManager.create(
			this.config.cwd,
			`${this.config.runRoot}/${this.config.runId}/sessions`,
		);
		sessionManager.setParentSession(parentFile);
		return this.createWithManager(role, selection, sessionManager, parentFile);
	}

	async open(reference: SessionReference, selection: ModelSelection): Promise<HostedSession> {
		const sessionManager = SessionManager.open(
			reference.file,
			`${this.config.runRoot}/${this.config.runId}/sessions`,
		);
		return this.createWithManager(reference.role, selection, sessionManager, reference.parentFile, reference);
	}

	private async createWithManager(
		role: SessionRole,
		selection: ModelSelection,
		sessionManager: SessionManager,
		parentFile?: string,
		existing?: SessionReference,
	): Promise<HostedSession> {
		const model = this.resolveModel(selection);
		let hosted: DrebHostedSession | undefined;
		const commandTool = createAuthorizedCommandTool(
			this.config.cwd,
			this.config.policy,
			(evidence) => hosted?.addCommandEvidence(evidence),
			this.options.commandRunner,
		);
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(this.config.cwd, agentDir);
		settingsManager.applyOverrides({ compaction: { continueAfterAutoCompaction: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.config.cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: this.config.cwd,
			agentDir,
			model,
			thinkingLevel: selection.thinkingLevel,
			modelRegistry: this.modelRegistry,
			sessionManager,
			settingsManager,
			resourceLoader,
			tools: roleToolSurface(role, this.config.cwd),
			customTools: role === "executor" ? [commandTool as import("@dreb/coding-agent").ToolDefinition<any, any>] : [],
			uiType: "long-horizon",
		});
		if (session.model?.provider !== selection.provider || session.model.id !== selection.modelId) {
			throw new Error("session silently changed the configured model");
		}
		if (session.thinkingLevel !== selection.thinkingLevel) {
			throw new Error(
				`session silently changed thinking from ${selection.thinkingLevel} to ${session.thinkingLevel}`,
			);
		}
		const file = session.sessionFile;
		if (!file) throw new Error("long-horizon sessions must be persisted");
		if (existing && (session.sessionId !== existing.id || file !== existing.file)) {
			throw new Error(`persisted session identity mismatch for ${existing.id}`);
		}
		const reference: SessionReference = existing ?? {
			id: session.sessionId || randomUUID(),
			role,
			file,
			parentFile,
			provider: selection.provider,
			modelId: selection.modelId,
			thinkingLevel: selection.thinkingLevel,
			createdAt: new Date().toISOString(),
		};
		hosted = new DrebHostedSession(session, reference);
		return hosted;
	}
}
