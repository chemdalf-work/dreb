import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type CommandRunner, getWorkspaceContext, getWorkspaceIdentity, runAuthorizedCommand } from "./policy.js";
import {
	continuationPrompt,
	escalationPrompt,
	finalVerificationPrompt,
	handoffPrompt,
	initialExecutionPrompt,
	planningPrompt,
} from "./prompts.js";
import {
	normalizeFailure,
	parseSolAdvice,
	parseSolPlan,
	parseTerraReport,
	validateHandoffArtifact,
	validateSolAdvice,
	validateSolPlan,
} from "./reports.js";
import { digest, RunStore } from "./run-store.js";
import { DrebSessionHost, type HostedSession, type PromptResult, type SessionHost } from "./session-host.js";
import { isTerminalPhase, replayJournal, selectNextAction } from "./state-machine.js";
import type {
	CapturedFailureEvidence,
	CommandEvidence,
	EffectKind,
	EscalationHistoryEntry,
	HandoffArtifact,
	HandoffHistoryEntry,
	LongHorizonRunConfig,
	LongHorizonStatus,
	SessionReference,
	SessionRole,
	SolAdvice,
	SolPlan,
	TerraRoundReport,
} from "./types.js";

export interface LongHorizonSupervisorOptions {
	sessionHost?: SessionHost;
	commandRunner?: CommandRunner;
}

interface ModelEffect<T> {
	effectId: string;
	value: T;
	result: PromptResult;
	artifact: string;
	artifactDigest: string;
}

function validatedModelArtifact<T>(input: unknown, name: string, validate: (value: unknown) => T): T | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error(`${name} artifact must be an object`);
	const artifact = input as Record<string, unknown>;
	const keys = Object.keys(artifact).sort();
	if (Object.hasOwn(artifact, "value")) {
		if (keys.join(",") !== "result,value") throw new Error(`${name} artifact has an invalid schema`);
		if (!artifact.result || typeof artifact.result !== "object" || Array.isArray(artifact.result)) {
			throw new Error(`${name} artifact result must be an object`);
		}
		return validate(artifact.value);
	}
	if (keys.join(",") !== "error,raw,result") throw new Error(`${name} artifact has an invalid schema`);
	if (typeof artifact.raw !== "string" || typeof artifact.error !== "string" || !artifact.error.trim()) {
		throw new Error(`${name} failure artifact has an invalid schema`);
	}
	if (!artifact.result || typeof artifact.result !== "object" || Array.isArray(artifact.result)) {
		throw new Error(`${name} artifact result must be an object`);
	}
	return undefined;
}

export class LongHorizonSupervisor {
	readonly store: RunStore;
	readonly config: LongHorizonRunConfig;
	private readonly sessions: SessionHost;
	private readonly commandRunner: CommandRunner;
	private active?: HostedSession;
	private stopping = false;

	constructor(store: RunStore, options: LongHorizonSupervisorOptions = {}) {
		this.store = store;
		this.config = store.config;
		this.commandRunner = options.commandRunner ?? runAuthorizedCommand;
		this.sessions = options.sessionHost ?? new DrebSessionHost(this.config, { commandRunner: this.commandRunner });
	}

	static create(config: LongHorizonRunConfig, options: LongHorizonSupervisorOptions = {}): LongHorizonSupervisor {
		return new LongHorizonSupervisor(RunStore.create(config), options);
	}

	static open(runDir: string, options: LongHorizonSupervisorOptions = {}): LongHorizonSupervisor {
		return new LongHorizonSupervisor(RunStore.open(runDir), options);
	}

	status(): LongHorizonStatus {
		const records = this.store.readRecords();
		if (records[0]?.event.type !== "run_created" || records[0].event.configDigest !== digest(this.config)) {
			throw new Error("run configuration does not match journal");
		}
		const state = replayJournal(records, this.config);
		const handoffSessions = new Map<string, string>();
		const handoffHistory: HandoffHistoryEntry[] = [];
		const escalationHistory: EscalationHistoryEntry[] = [];
		for (const record of records) {
			const event = record.event;
			if (event.type === "effect_intent" && event.kind === "handoff") {
				if (event.sessionId) handoffSessions.set(event.effectId, event.sessionId);
				continue;
			}
			if (event.type === "effect_abandoned" && event.kind === "handoff") {
				handoffSessions.delete(event.effectId);
				continue;
			}
			if (event.type === "effect_completed" && event.kind === "handoff") {
				const fromSessionId = handoffSessions.get(event.effectId);
				if (!fromSessionId || !event.artifact || !event.artifactDigest) {
					throw new Error(
						`completed handoff ${event.effectId} is missing its durable source or artifact reference`,
					);
				}
				const handoff = validateHandoffArtifact(
					this.store.readArtifact<unknown>(event.artifact, event.artifactDigest),
				);
				if (handoff.fromSessionId !== fromSessionId) {
					throw new Error("handoff intent session does not match the handoff artifact source session");
				}
				handoffHistory.push({
					seq: record.seq,
					timestamp: record.timestamp,
					effectId: event.effectId,
					fromSessionId,
					artifact: event.artifact,
					artifactDigest: event.artifactDigest,
				});
				handoffSessions.delete(event.effectId);
				continue;
			}
			if (event.type === "escalation_completed") {
				escalationHistory.push({
					seq: record.seq,
					timestamp: record.timestamp,
					workUnitId: event.workUnitId,
					signature: event.signature,
					adviceArtifact: event.adviceArtifact,
					adviceArtifactDigest: event.adviceArtifactDigest,
				});
			}
		}
		return {
			...state,
			limits: this.config.limits,
			rollover: this.config.rollover,
			elapsedMs: Math.max(0, Date.now() - Date.parse(this.config.createdAt)),
			handoffHistory,
			escalationHistory,
		};
	}

	requestPause(reason?: string): void {
		this.store.requestControl("pause", reason);
	}

	requestResume(reason?: string): void {
		this.store.requestControl("resume", reason);
	}

	async requestAbort(reason = "operator requested abort"): Promise<void> {
		this.store.requestControl("abort", reason);
		this.stopping = true;
		if (this.active) await this.active.abort();
	}

	private latestArtifact(kind: EffectKind): { path: string; digest: string } | undefined {
		for (const record of this.store.readRecords().toReversed()) {
			if (
				record.event.type === "effect_completed" &&
				record.event.kind === kind &&
				record.event.artifact &&
				record.event.artifactDigest
			) {
				return { path: record.event.artifact, digest: record.event.artifactDigest };
			}
		}
		return undefined;
	}

	private loadPlan(): SolPlan | undefined {
		const artifact = this.latestArtifact("plan");
		if (!artifact) return undefined;
		const plan = validatedModelArtifact(
			this.store.readArtifact<unknown>(artifact.path, artifact.digest),
			"plan",
			validateSolPlan,
		);
		if (plan && plan.objective !== this.config.objective) throw new Error("persisted plan changed the run objective");
		return plan;
	}

	private loadLastReport(): TerraRoundReport | undefined {
		for (const record of this.store.readRecords().toReversed()) {
			if (record.event.type === "round_completed") return record.event.report;
		}
		return undefined;
	}

	private loadLastAdvice(): SolAdvice | undefined {
		const artifact = this.latestArtifact("advice");
		return artifact
			? validatedModelArtifact(
					this.store.readArtifact<unknown>(artifact.path, artifact.digest),
					"advice",
					validateSolAdvice,
				)
			: undefined;
	}

	private loadLastHandoff(): HandoffArtifact | undefined {
		const artifact = this.latestArtifact("handoff");
		return artifact
			? validateHandoffArtifact(this.store.readArtifact<unknown>(artifact.path, artifact.digest))
			: undefined;
	}

	private async createSession(role: SessionRole, parentFile?: string): Promise<HostedSession> {
		const selection =
			role === "planner"
				? this.config.planner
				: role === "executor"
					? this.config.executor
					: role === "advisor"
						? this.config.advisor
						: this.config.verifier!;
		const effectId = randomUUID();
		this.store.append({ type: "effect_intent", effectId, kind: "session" });
		const hosted = await this.sessions.create(role, selection, parentFile);
		this.store.append({ type: "session_registered", session: hosted.reference });
		this.store.append({ type: "effect_completed", effectId, kind: "session" });
		return hosted;
	}

	private async openExecutor(reference: SessionReference): Promise<HostedSession> {
		return this.sessions.open(reference, this.config.executor);
	}

	private async promptWithAbortWatch(session: HostedSession, prompt: string): Promise<PromptResult> {
		let abortSent = false;
		let abortPromise: Promise<void> | undefined;
		let watchError: Error | undefined;
		const abort = () => {
			if (abortSent) return;
			abortSent = true;
			abortPromise = session.abort().catch((error) => {
				watchError = error as Error;
			});
		};
		const watcher = setInterval(() => {
			try {
				if (this.store.replay().pendingControl === "abort") abort();
			} catch (error) {
				watchError = error as Error;
				abort();
			}
		}, 100);
		watcher.unref();
		let result: PromptResult;
		try {
			if (this.stopping || this.store.replay().pendingControl === "abort") {
				throw new Error("model prompt dispatch cancelled by operator abort");
			}
			result = await session.prompt(prompt);
		} finally {
			clearInterval(watcher);
			await abortPromise;
		}
		if (watchError) throw new Error(`control watcher failed: ${watchError.message}`);
		return result;
	}

	private async modelEffect<T>(
		kind: EffectKind,
		session: HostedSession,
		prompt: string,
		parse: (text: string, result: PromptResult) => T,
		deferCompletion = false,
	): Promise<ModelEffect<T>> {
		const effectId = randomUUID();
		this.store.append({ type: "effect_intent", effectId, kind, sessionId: session.reference.id });
		let result: PromptResult;
		try {
			result = await this.promptWithAbortWatch(session, prompt);
		} catch (error) {
			if (this.store.replay().pendingControl === "abort") {
				this.store.append({ type: "effect_abandoned", effectId, kind, reason: "model effect aborted by operator" });
			}
			throw error;
		}
		this.store.append({
			type: "usage_recorded",
			role: session.reference.role,
			tokens: result.tokens,
			costUsd: result.costUsd,
		});
		if (result.context) {
			this.store.append({ type: "context_observed", sessionId: session.reference.id, ...result.context });
		}
		let value: T;
		try {
			value = parse(result.text, result);
		} catch (error) {
			const artifact = this.store.writeArtifact(kind, effectId, {
				raw: result.text,
				error: (error as Error).message,
				result,
			});
			const artifactDigest = this.store.artifactDigest(artifact);
			if (!deferCompletion) {
				this.store.append({ type: "effect_completed", effectId, kind, artifact, artifactDigest });
			}
			throw error;
		}
		const artifact = this.store.writeArtifact(kind, effectId, { value, result });
		const artifactDigest = this.store.artifactDigest(artifact);
		if (!deferCompletion) this.store.append({ type: "effect_completed", effectId, kind, artifact, artifactDigest });
		return { effectId, value, result, artifact, artifactDigest };
	}

	private block(reason: string): void {
		const state = this.store.replay();
		if (state.phase !== "blocked") this.store.append({ type: "blocked", reason });
	}

	private terminal(phase: "completed" | "failed" | "aborted", reason: string): void {
		if (!isTerminalPhase(this.store.replay().phase)) this.store.append({ type: "terminal", phase, reason });
	}

	private failIfResourceLimitReached(includeRoundLimit = true): boolean {
		const state = this.store.replay();
		const exhausted =
			(includeRoundLimit && state.rounds >= this.config.limits.maxRounds) ||
			state.totalTokens >= this.config.limits.maxTotalTokens ||
			state.totalCostUsd >= this.config.limits.maxCostUsd ||
			Date.now() - Date.parse(this.config.createdAt) >= this.config.limits.maxElapsedMs;
		if (!exhausted) return false;
		this.terminal("failed", "resource limit exhausted");
		return true;
	}

	private async plan(): Promise<SolPlan> {
		const planner = await this.createSession("planner");
		try {
			const effect = await this.modelEffect("plan", planner, planningPrompt(this.config), (text, result) => {
				if (result.askUserObserved) throw new Error("planner requested human input");
				const plan = parseSolPlan(text);
				if (plan.objective !== this.config.objective) throw new Error("planner changed the persisted objective");
				return plan;
			});
			return effect.value;
		} finally {
			planner.dispose();
		}
	}

	private capturedFailure(report: TerraRoundReport, result: PromptResult): CapturedFailureEvidence {
		const command = result.commandEvidence.find(
			(item) => report.evidenceIds.includes(item.id) && (item.exitCode !== 0 || item.termination !== undefined),
		);
		if (command) return { source: "command", evidence: { ...command } };
		const tool = result.toolEvidence.find((item) => report.evidenceIds.includes(item.id) && item.isError);
		if (!tool) throw new Error("verification-failed report has no matching captured failure evidence");
		return {
			source: "tool",
			evidence: { ...tool, args: tool.args ?? null, result: tool.result ?? null },
		};
	}

	private normalizedCapturedFailure(captured: CapturedFailureEvidence): NonNullable<TerraRoundReport["failure"]> {
		if (captured.source === "command") {
			const evidence = captured.evidence;
			return {
				operation: "run_command",
				command: evidence.command,
				exitCode: evidence.exitCode,
				diagnostic: evidence.stderr || evidence.stdout || evidence.termination || "command failed",
			};
		}
		return {
			operation: captured.evidence.toolName,
			diagnostic: JSON.stringify(captured.evidence.result),
		};
	}

	private validateAdviceForFailure(advice: SolAdvice, report: TerraRoundReport, signature: string): void {
		if (advice.workUnitId !== report.workUnitId || advice.failureSignature !== signature) {
			throw new Error("advisor response does not match the escalated failure");
		}
		if (advice.strategyId === report.strategyId) {
			throw new Error("advisor response must propose a different strategy ID");
		}
	}

	private async advise(
		plan: SolPlan,
		report: TerraRoundReport,
		signature: string,
		failureEvidence: CapturedFailureEvidence,
	): Promise<SolAdvice> {
		const advisor = await this.createSession("advisor");
		try {
			const workspace = await getWorkspaceContext(this.config.cwd);
			const effect = await this.modelEffect(
				"advice",
				advisor,
				escalationPrompt(this.config, plan, report, signature, workspace, failureEvidence),
				(text) => parseSolAdvice(text),
			);
			this.validateAdviceForFailure(effect.value, report, signature);
			this.store.append({
				type: "escalation_completed",
				workUnitId: report.workUnitId,
				signature,
				adviceArtifact: effect.artifact,
				adviceArtifactDigest: effect.artifactDigest,
			});
			return effect.value;
		} finally {
			advisor.dispose();
		}
	}

	private loadLastFailureEvidence(report: TerraRoundReport): CapturedFailureEvidence {
		for (const record of this.store.readRecords().toReversed()) {
			if (record.event.type !== "round_completed") continue;
			if (
				record.event.report.workUnitId !== report.workUnitId ||
				record.event.report.strategyId !== report.strategyId ||
				record.event.failureEvidence === undefined
			) {
				throw new Error("persisted failed round is missing matching captured evidence");
			}
			return record.event.failureEvidence;
		}
		throw new Error("persisted failed round is missing");
	}

	private async recoverPendingEscalation(plan: SolPlan, report: TerraRoundReport): Promise<SolAdvice | undefined> {
		const failure = this.store.replay().failureStreak;
		if (!failure || failure.count <= this.config.limits.failureThreshold) return undefined;
		const existing = this.loadLastAdvice();
		if (failure.escalated) {
			if (!existing) throw new Error("completed escalation is missing persisted advice");
			this.validateAdviceForFailure(existing, report, failure.signature);
			return existing;
		}
		if (
			existing?.workUnitId === failure.workUnitId &&
			existing.failureSignature === failure.signature &&
			existing.strategyId !== report.strategyId
		) {
			this.validateAdviceForFailure(existing, report, failure.signature);
			const artifact = this.latestArtifact("advice")!;
			this.store.append({
				type: "escalation_completed",
				workUnitId: failure.workUnitId,
				signature: failure.signature,
				adviceArtifact: artifact.path,
				adviceArtifactDigest: artifact.digest,
			});
			return existing;
		}
		if (this.store.replay().escalations >= this.config.limits.maxEscalations) {
			throw new Error("escalation limit exhausted during recovery");
		}
		return this.advise(plan, report, failure.signature, this.loadLastFailureEvidence(report));
	}

	private async runAcceptance(plan: SolPlan): Promise<"passed" | "failed" | "controlled"> {
		const effectId = randomUUID();
		this.store.append({ type: "effect_intent", effectId, kind: "acceptance" });
		const evidence: CommandEvidence[] = [];
		const finish = () => {
			const artifact = this.store.writeArtifact("acceptance", effectId, evidence);
			this.store.append({
				type: "effect_completed",
				effectId,
				kind: "acceptance",
				artifact,
				artifactDigest: this.store.artifactDigest(artifact),
			});
		};
		for (const command of this.config.acceptanceCommands) {
			if (this.store.replay().pendingControl === "abort" || this.store.replay().pendingControl === "pause") {
				finish();
				this.applyControl();
				return "controlled";
			}
			const policy = {
				...this.config.policy,
				allowedCommands: [...this.config.policy.allowedCommands, command],
			};
			const controller = new AbortController();
			let watchError: Error | undefined;
			const watcher = setInterval(() => {
				try {
					if (this.store.replay().pendingControl === "abort") controller.abort();
				} catch (error) {
					watchError = error as Error;
					controller.abort();
				}
			}, 100);
			watcher.unref();
			let result: CommandEvidence;
			try {
				result = await this.commandRunner(command, this.config.cwd, policy, controller.signal);
			} finally {
				clearInterval(watcher);
			}
			if (watchError) throw new Error(`acceptance control watcher failed: ${watchError.message}`);
			evidence.push(result);
			this.store.append({ type: "acceptance_recorded", evidence: result });
			if (result.exitCode !== 0 || result.termination) {
				finish();
				if (this.store.replay().pendingControl) {
					this.applyControl();
					return "controlled";
				}
				return "failed";
			}
		}
		const currentIdentity = await getWorkspaceIdentity(this.config.cwd);
		const fresh = evidence.every((item) => item.workspaceIdentity === currentIdentity);
		finish();
		if (this.store.replay().pendingControl) {
			this.applyControl();
			return "controlled";
		}
		if (this.failIfResourceLimitReached(false)) return "controlled";
		if (!fresh) return "failed";

		if (this.config.verifier) {
			const verifier = await this.createSession("verifier");
			try {
				const assessment = await this.modelEffect(
					"final-verification",
					verifier,
					finalVerificationPrompt(
						this.config,
						plan,
						evidence.map((item) => item.id),
					),
					(text) => parseSolAdvice(text),
				);
				if (this.store.replay().pendingControl) {
					this.applyControl();
					return "controlled";
				}
				if (this.failIfResourceLimitReached(false)) return "controlled";
				if (
					assessment.value.workUnitId !== "final" ||
					assessment.value.failureSignature !== "none" ||
					assessment.value.strategyId !== "accept"
				) {
					return "failed";
				}
			} finally {
				verifier.dispose();
			}
		}
		return "passed";
	}

	private async rollover(report: TerraRoundReport): Promise<HostedSession> {
		if (!this.active) throw new Error("cannot roll over without an active executor session");
		const old = this.active;
		const effectId = randomUUID();
		this.store.append({
			type: "phase_changed",
			from: this.store.replay().phase,
			to: "handoff",
			reason: "safe-edge rollover",
		});
		this.store.append({ type: "effect_intent", effectId, kind: "handoff", sessionId: old.reference.id });
		const handoff: HandoffArtifact = {
			schemaVersion: 1,
			fromSessionId: old.reference.id,
			workUnitId: report.workUnitId,
			strategyId: report.strategyId,
			summary: report.progress,
			nextAction: report.nextAction,
			evidenceIds: report.evidenceIds,
			createdAt: new Date().toISOString(),
		};
		const artifact = this.store.writeArtifact("handoff", effectId, handoff);
		const artifactDigest = this.store.artifactDigest(artifact);
		this.store.append({ type: "effect_completed", effectId, kind: "handoff", artifact, artifactDigest });
		validateHandoffArtifact(this.store.readArtifact<unknown>(artifact, artifactDigest));
		old.dispose();
		const next = await this.createSession("executor", old.reference.file);
		this.active = next;
		this.store.append({
			type: "phase_changed",
			from: "handoff",
			to: "executing",
			reason: "fresh parent-linked executor registered",
		});
		return next;
	}

	private applyControl(): boolean {
		const state = this.store.replay();
		if (state.pendingControl === "abort" || this.stopping) {
			this.terminal("aborted", "operator requested abort");
			return true;
		}
		if (state.pendingControl === "pause") {
			this.store.append({
				type: "phase_changed",
				from: state.phase,
				to: "paused",
				reason: "operator requested pause",
			});
			return true;
		}
		return false;
	}

	async run(): Promise<LongHorizonStatus> {
		const releaseOwnership = this.store.acquireOwnership();
		try {
			return await this.runOwned();
		} finally {
			releaseOwnership();
		}
	}

	private async runOwned(): Promise<LongHorizonStatus> {
		let state = this.store.replay();
		if (state.pendingEffect) {
			this.block(
				`ambiguous interrupted ${state.pendingEffect.kind} effect ${state.pendingEffect.effectId}; inspect its linked session before resuming`,
			);
			return this.status();
		}
		if (state.pendingControl === "resume") {
			if (state.phase !== "paused" && state.phase !== "blocked")
				throw new Error("resume requested for a non-paused run");
			const target = this.loadPlan() ? "executing" : "planning";
			this.store.append({ type: "phase_changed", from: state.phase, to: target, reason: "resume" });
			state = this.store.replay();
		}
		if (state.pendingControl === "pause" || state.pendingControl === "abort") {
			this.applyControl();
			return this.status();
		}
		if (this.failIfResourceLimitReached(false)) return this.status();
		if (state.phase === "paused" || state.phase === "blocked" || isTerminalPhase(state.phase)) return this.status();
		try {
			await this.sessions.validate?.();
		} catch (error) {
			this.terminal("failed", `session configuration validation failed: ${(error as Error).message}`);
			return this.status();
		}
		try {
			await getWorkspaceIdentity(this.config.cwd);
		} catch (error) {
			this.terminal("failed", `workspace validation failed: ${(error as Error).message}`);
			return this.status();
		}
		if (state.phase === "created") {
			this.store.append({ type: "phase_changed", from: "created", to: "planning", reason: "run started" });
		}

		let plan = this.loadPlan();
		if (!plan) {
			try {
				plan = await this.plan();
			} catch (error) {
				if (!this.applyControl()) this.block(`planning failed: ${(error as Error).message}`);
				return this.status();
			}
		}
		state = this.store.replay();
		if (this.applyControl()) return this.status();
		if (this.failIfResourceLimitReached()) return this.status();
		if (state.phase === "planning") {
			this.store.append({
				type: "phase_changed",
				from: "planning",
				to: "executing",
				reason: "validated plan persisted",
			});
		}

		let previous = this.loadLastReport();
		state = this.store.replay();
		const activeReference = state.sessions.find((session) => session.id === state.activeSessionId);
		if (state.phase !== "handoff") {
			if (activeReference && existsSync(activeReference.file)) {
				try {
					this.active = await this.openExecutor(activeReference);
				} catch (error) {
					this.block(`could not reopen executor session ${activeReference.id}: ${(error as Error).message}`);
					return this.status();
				}
			} else {
				// A registered session with no file never received an assistant turn, so it is
				// safe to replace without duplicating a model round.
				this.active = await this.createSession("executor", activeReference?.parentFile);
			}
		}

		let nextPrompt: string;
		if (state.phase === "handoff") {
			const handoff = this.loadLastHandoff();
			if (!handoff) {
				this.block("handoff phase has no durable handoff artifact");
				return this.status();
			}
			const parent = state.sessions.find((session) => session.id === handoff.fromSessionId);
			if (!parent) {
				this.block("handoff parent session is missing");
				return this.status();
			}
			const registeredChild = activeReference?.id === parent.id ? undefined : activeReference;
			if (registeredChild && registeredChild.parentFile !== parent.file) {
				this.block("active handoff session does not descend from the persisted parent");
				return this.status();
			}
			if (registeredChild && existsSync(registeredChild.file)) {
				try {
					this.active = await this.openExecutor(registeredChild);
				} catch (error) {
					this.block(`could not reopen executor session ${registeredChild.id}: ${(error as Error).message}`);
					return this.status();
				}
			} else {
				// Whether the exhausted parent already has a parent is irrelevant: a
				// handoff always resumes in a child of handoff.fromSessionId.
				this.active = await this.createSession("executor", parent.file);
			}
			this.store.append({
				type: "phase_changed",
				from: "handoff",
				to: "executing",
				reason: "resumed durable handoff",
			});
			nextPrompt = handoffPrompt(handoff);
		} else if (
			previous &&
			((state.context?.tokens ?? 0) >= this.config.rollover.strongTokens ||
				(state.phase === "wrapping" && previous.handoffReady))
		) {
			if (state.handoffs >= this.config.limits.maxHandoffs) {
				this.terminal("failed", "handoff limit exhausted");
				return this.status();
			}
			this.active = await this.rollover(previous);
			nextPrompt = handoffPrompt(this.loadLastHandoff()!);
		} else if (previous?.status === "complete") {
			try {
				const acceptance = await this.runAcceptance(plan);
				if (acceptance === "passed" && !this.applyControl()) {
					this.terminal("completed", "all persisted acceptance commands passed with fresh evidence");
				} else if (acceptance === "failed") {
					this.block("completion candidate rejected by acceptance or final verification");
				}
			} catch (error) {
				if (!this.applyControl()) this.block(`acceptance failed: ${(error as Error).message}`);
			}
			return this.status();
		} else if (previous?.status === "blocked") {
			this.block(previous.progress);
			return this.status();
		} else {
			if (
				previous &&
				(state.context?.tokens ?? 0) >= this.config.rollover.softTokens &&
				state.phase === "executing"
			) {
				this.store.append({
					type: "phase_changed",
					from: "executing",
					to: "wrapping",
					reason: "soft context threshold recovered at safe edge",
				});
				state = this.store.replay();
			}
			let recoveredAdvice: SolAdvice | undefined;
			if (previous?.status === "verification-failed") {
				try {
					recoveredAdvice = await this.recoverPendingEscalation(plan, previous);
				} catch (error) {
					if (!this.applyControl()) this.block(`advisor escalation recovery failed: ${(error as Error).message}`);
					return this.status();
				}
			}
			nextPrompt = previous
				? continuationPrompt(previous, state.phase === "wrapping", recoveredAdvice)
				: initialExecutionPrompt(this.config, plan);
		}

		try {
			while (true) {
				state = this.store.replay();
				const action = selectNextAction(state, this.config);
				if (action === "stop") return this.status();
				if (action === "abort" || action === "pause") {
					this.applyControl();
					return this.status();
				}
				if (action === "reconcile") {
					this.block(`ambiguous interrupted ${state.pendingEffect!.kind} effect ${state.pendingEffect!.effectId}`);
					return this.status();
				}
				if (action === "fail-budget") {
					this.terminal("failed", "resource limit exhausted");
					return this.status();
				}

				let effect: ModelEffect<TerraRoundReport>;
				try {
					effect = await this.modelEffect(
						"round",
						this.active!,
						nextPrompt,
						(text, result) => parseTerraReport(text, [...result.toolEvidence, ...result.commandEvidence]),
						true,
					);
				} catch (error) {
					if (!this.applyControl()) this.block(`executor round failed validation: ${(error as Error).message}`);
					return this.status();
				}
				if (effect.result.askUserObserved) {
					this.block("executor requested human input");
					return this.status();
				}
				const report = effect.value;
				const beforeRound = this.store.replay();
				const successfulVerification = effect.result.commandEvidence.some(
					(item) =>
						item.exitCode === 0 &&
						item.termination === undefined &&
						report.evidenceIds.includes(item.id) &&
						this.config.acceptanceCommands.includes(item.command),
				);
				const failureEvidence =
					report.status === "verification-failed" && report.failure
						? this.capturedFailure(report, effect.result)
						: undefined;
				const failureSignature = failureEvidence
					? normalizeFailure(this.normalizedCapturedFailure(failureEvidence))
					: undefined;
				this.store.append({
					type: "round_completed",
					effectId: effect.effectId,
					artifact: effect.artifact,
					artifactDigest: effect.artifactDigest,
					round: beforeRound.rounds + 1,
					report,
					failureSignature,
					failureEvidence,
					verificationSucceeded: successfulVerification,
				});
				if (this.applyControl()) return this.status();
				if (this.failIfResourceLimitReached(report.status !== "complete")) return this.status();

				let advice: SolAdvice | undefined;
				if (failureSignature) {
					const signature = failureSignature;
					const failure = this.store.replay().failureStreak!;
					if (failure.count > this.config.limits.failureThreshold && !failure.escalated) {
						if (this.store.replay().escalations >= this.config.limits.maxEscalations) {
							this.terminal("failed", "escalation limit exhausted");
							return this.status();
						}
						try {
							advice = await this.advise(plan, report, signature, failureEvidence!);
						} catch (error) {
							if (!this.applyControl()) this.block(`advisor escalation failed: ${(error as Error).message}`);
							return this.status();
						}
					}
					if (failure.count > this.config.limits.failureThreshold + this.config.limits.maxUnchangedFailureCycles) {
						this.terminal("failed", "unchanged failure-cycle limit exhausted");
						return this.status();
					}
				}

				if (report.status === "blocked") {
					this.block(report.progress);
					return this.status();
				}
				if (report.status === "complete") {
					try {
						const acceptance = await this.runAcceptance(plan);
						if (acceptance === "passed") {
							if (!this.applyControl()) {
								this.terminal("completed", "all persisted acceptance commands passed with fresh evidence");
							}
						} else if (acceptance === "failed") {
							this.block("completion candidate rejected by acceptance or final verification");
						}
					} catch (error) {
						if (!this.applyControl()) this.block(`acceptance failed: ${(error as Error).message}`);
					}
					return this.status();
				}
				if (this.applyControl()) return this.status();

				const context = this.store.replay().context;
				const strong = context && context.tokens >= this.config.rollover.strongTokens;
				const soft = context && context.tokens >= this.config.rollover.softTokens;
				if (strong || (this.store.replay().phase === "wrapping" && report.handoffReady)) {
					if (this.store.replay().handoffs >= this.config.limits.maxHandoffs) {
						this.terminal("failed", "handoff limit exhausted");
						return this.status();
					}
					this.active = await this.rollover(report);
					const handoffArtifact = this.latestArtifact("handoff")!;
					const handoff = validateHandoffArtifact(
						this.store.readArtifact<unknown>(handoffArtifact.path, handoffArtifact.digest),
					);
					nextPrompt = handoffPrompt(handoff);
				} else {
					if (soft && this.store.replay().phase === "executing") {
						this.store.append({
							type: "phase_changed",
							from: "executing",
							to: "wrapping",
							reason: "soft context threshold reached",
						});
					}
					nextPrompt = continuationPrompt(report, this.store.replay().phase === "wrapping", advice);
				}
				previous = report;
			}
		} finally {
			this.active?.dispose();
			this.active = undefined;
		}
	}
}
