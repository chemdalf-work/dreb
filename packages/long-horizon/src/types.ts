export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const RUN_SCHEMA_VERSION = 1 as const;
export const JOURNAL_SCHEMA_VERSION = 1 as const;

export type RunPhase =
	| "created"
	| "planning"
	| "executing"
	| "wrapping"
	| "handoff"
	| "blocked"
	| "paused"
	| "completed"
	| "failed"
	| "aborted";

export type SessionRole = "planner" | "executor" | "advisor" | "verifier";
export type ControlAction = "pause" | "resume" | "abort";

export interface ModelSelection {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

export interface RunLimits {
	maxRounds: number;
	maxTotalTokens: number;
	maxCostUsd: number;
	maxElapsedMs: number;
	maxHandoffs: number;
	maxEscalations: number;
	maxUnchangedFailureCycles: number;
	failureThreshold: number;
}

export interface RolloverThresholds {
	softTokens: number;
	strongTokens: number;
}

export interface AuthorizationPolicy {
	/** Exact shell-free command strings that executor sessions may invoke. */
	allowedCommands: readonly string[];
	allowDestructiveGit: boolean;
	allowRelease: boolean;
	allowDeploy: boolean;
	allowCredentials: boolean;
	allowRemoteState: boolean;
	commandTimeoutMs: number;
	maxOutputBytes: number;
}

export interface LongHorizonRunConfig {
	schemaVersion: typeof RUN_SCHEMA_VERSION;
	runId: string;
	objective: string;
	cwd: string;
	runRoot: string;
	planner: ModelSelection;
	executor: ModelSelection;
	advisor: ModelSelection;
	verifier?: ModelSelection;
	acceptanceCommands: readonly string[];
	limits: RunLimits;
	rollover: RolloverThresholds;
	policy: AuthorizationPolicy;
	createdAt: string;
}

export interface SessionReference {
	id: string;
	role: SessionRole;
	file: string;
	parentFile?: string;
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	createdAt: string;
}

export interface ToolEvidence {
	id: string;
	toolName: string;
	startedAt: string;
	completedAt: string;
	args: unknown;
	result: unknown;
	isError: boolean;
}

export interface CommandEvidence {
	id: string;
	command: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	startedAt: string;
	completedAt: string;
	workspaceIdentity: string;
	termination?: "timeout" | "aborted";
}

export interface SolPlan {
	schemaVersion: 1;
	objective: string;
	workUnits: Array<{ id: string; title: string; acceptance: string[] }>;
	acceptanceCriteria: string[];
	constraints: string[];
}

export interface TerraRoundReport {
	schemaVersion: 1;
	status: "progress" | "failed" | "blocked" | "complete" | "handoff_ready";
	workUnitId: string;
	strategyId: string;
	progress: string;
	evidenceIds: string[];
	failure?: {
		operation: string;
		command?: string;
		exitCode?: number | null;
		diagnostic: string;
	};
	handoffReady: boolean;
	nextAction: string;
}

export interface SolAdvice {
	schemaVersion: 1;
	workUnitId: string;
	failureSignature: string;
	strategyId: string;
	advice: string;
}

export interface HandoffArtifact {
	schemaVersion: 1;
	fromSessionId: string;
	workUnitId: string;
	strategyId: string;
	summary: string;
	nextAction: string;
	evidenceIds: string[];
	createdAt: string;
}

export type EffectKind = "session" | "plan" | "round" | "advice" | "handoff" | "acceptance" | "final-verification";

export type JournalEventData =
	| { type: "run_created"; configDigest: string }
	| { type: "phase_changed"; from: RunPhase; to: RunPhase; reason: string }
	| { type: "control_requested"; action: ControlAction; reason?: string }
	| { type: "session_registered"; session: SessionReference }
	| { type: "effect_intent"; effectId: string; kind: EffectKind; sessionId?: string }
	| { type: "effect_completed"; effectId: string; kind: EffectKind; artifact?: string }
	| { type: "effect_abandoned"; effectId: string; kind: EffectKind; reason: string }
	| {
			type: "round_completed";
			round: number;
			report: TerraRoundReport;
			failureSignature?: string;
			verificationSucceeded: boolean;
	  }
	| { type: "usage_recorded"; role: SessionRole; tokens: number; costUsd: number }
	| { type: "context_observed"; sessionId: string; tokens: number; contextWindow: number }
	| { type: "failure_recorded"; workUnitId: string; strategyId: string; signature: string }
	| { type: "failure_reset"; workUnitId: string; reason: "verification" | "strategy_changed" }
	| { type: "escalation_completed"; workUnitId: string; signature: string; adviceArtifact: string }
	| { type: "acceptance_recorded"; evidence: CommandEvidence }
	| { type: "blocked"; reason: string }
	| { type: "terminal"; phase: "completed" | "failed" | "aborted"; reason: string };

export interface JournalRecord {
	schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
	seq: number;
	timestamp: string;
	previousHash: string;
	event: JournalEventData;
	hash: string;
}

export interface FailureStreak {
	workUnitId: string;
	strategyId: string;
	signature: string;
	count: number;
	escalated: boolean;
}

export interface RunState {
	schemaVersion: typeof RUN_SCHEMA_VERSION;
	runId: string;
	phase: RunPhase;
	createdAt: string;
	updatedAt: string;
	lastSeq: number;
	lastHash: string;
	rounds: number;
	totalTokens: number;
	totalCostUsd: number;
	handoffs: number;
	escalations: number;
	activeSessionId?: string;
	sessions: SessionReference[];
	pendingEffect?: { effectId: string; kind: EffectKind; sessionId?: string };
	pendingControl?: ControlAction;
	blockedReason?: string;
	lastWorkUnitId?: string;
	lastStrategyId?: string;
	failureStreak?: FailureStreak;
	context?: { tokens: number; contextWindow: number };
	lastEvent: JournalEventData;
}

export interface LongHorizonStatus extends RunState {
	limits: RunLimits;
	rollover: RolloverThresholds;
	elapsedMs: number;
}
