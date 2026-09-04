import type { JournalRecord, LongHorizonRunConfig, RunPhase, RunState } from "./types.js";

const TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
	created: ["planning", "blocked", "paused", "aborted", "failed"],
	planning: ["executing", "blocked", "paused", "aborted", "failed"],
	executing: ["wrapping", "handoff", "blocked", "paused", "completed", "aborted", "failed"],
	wrapping: ["executing", "handoff", "blocked", "paused", "completed", "aborted", "failed"],
	handoff: ["executing", "blocked", "paused", "aborted", "failed"],
	blocked: ["planning", "executing", "paused", "aborted", "failed"],
	paused: ["planning", "executing", "wrapping", "handoff", "aborted", "failed"],
	completed: [],
	failed: [],
	aborted: [],
};

export function isTerminalPhase(phase: RunPhase): boolean {
	return phase === "completed" || phase === "failed" || phase === "aborted";
}

function initialState(config: LongHorizonRunConfig, record: JournalRecord): RunState {
	if (record.event.type !== "run_created" || record.seq !== 0 || record.previousHash !== "") {
		throw new Error("journal must begin with run_created at sequence 0");
	}
	return {
		schemaVersion: 1,
		runId: config.runId,
		phase: "created",
		createdAt: config.createdAt,
		updatedAt: record.timestamp,
		lastSeq: record.seq,
		lastHash: record.hash,
		rounds: 0,
		totalTokens: 0,
		totalCostUsd: 0,
		handoffs: 0,
		escalations: 0,
		sessions: [],
		lastEvent: record.event,
	};
}

function requireTransition(from: RunPhase, to: RunPhase): void {
	if (!TRANSITIONS[from].includes(to)) throw new Error(`invalid phase transition: ${from} -> ${to}`);
}

export function applyJournalRecord(
	previous: RunState | undefined,
	record: JournalRecord,
	config: LongHorizonRunConfig,
): RunState {
	if (!previous) return initialState(config, record);
	if (record.seq !== previous.lastSeq + 1) throw new Error(`journal sequence gap at ${record.seq}`);
	if (record.previousHash !== previous.lastHash) throw new Error(`journal hash chain mismatch at ${record.seq}`);
	if (isTerminalPhase(previous.phase)) throw new Error(`event after terminal phase at ${record.seq}`);

	const next: RunState = {
		...previous,
		updatedAt: record.timestamp,
		lastSeq: record.seq,
		lastHash: record.hash,
		lastEvent: record.event,
		sessions: [...previous.sessions],
	};
	const event = record.event;

	switch (event.type) {
		case "run_created":
			throw new Error("duplicate run_created event");
		case "phase_changed":
			if (event.from !== previous.phase)
				throw new Error(`phase_changed expected ${previous.phase}, got ${event.from}`);
			requireTransition(event.from, event.to);
			next.phase = event.to;
			if (event.to !== "blocked") next.blockedReason = undefined;
			if (event.to === "paused" || event.reason === "resume") next.pendingControl = undefined;
			break;
		case "control_requested":
			if (event.action === "resume" && previous.phase !== "paused" && previous.phase !== "blocked") {
				throw new Error("resume is only valid for paused or blocked runs");
			}
			next.pendingControl = event.action;
			break;
		case "session_registered":
			if (
				previous.sessions.some((session) => session.id === event.session.id || session.file === event.session.file)
			) {
				throw new Error(`duplicate session registration: ${event.session.id}`);
			}
			if (
				event.session.role === "executor" &&
				event.session.parentFile &&
				previous.handoffs >= config.limits.maxHandoffs
			) {
				throw new Error("handoff limit exhausted");
			}
			next.sessions.push(event.session);
			if (event.session.role === "executor") next.activeSessionId = event.session.id;
			if (event.session.role === "executor" && event.session.parentFile) next.handoffs++;
			break;
		case "effect_intent":
			if (previous.pendingEffect) throw new Error(`effect ${previous.pendingEffect.effectId} is still pending`);
			next.pendingEffect = { effectId: event.effectId, kind: event.kind, sessionId: event.sessionId };
			break;
		case "effect_completed":
		case "effect_abandoned":
			if (!previous.pendingEffect || previous.pendingEffect.effectId !== event.effectId) {
				throw new Error(`effect resolution without matching intent: ${event.effectId}`);
			}
			if (previous.pendingEffect.kind !== event.kind) throw new Error(`effect kind mismatch: ${event.effectId}`);
			next.pendingEffect = undefined;
			if (event.type === "effect_abandoned") next.blockedReason = event.reason;
			break;
		case "round_completed": {
			if (event.round !== previous.rounds + 1) throw new Error(`invalid round number: ${event.round}`);
			if (event.round > config.limits.maxRounds) throw new Error(`round limit exceeded: ${event.round}`);
			next.rounds = event.round;
			next.lastWorkUnitId = event.report.workUnitId;
			next.lastStrategyId = event.report.strategyId;
			const prior = previous.failureStreak;
			if (
				event.verificationSucceeded ||
				(prior?.workUnitId === event.report.workUnitId && prior.strategyId !== event.report.strategyId)
			) {
				next.failureStreak = undefined;
			}
			if (event.failureSignature) {
				const current = next.failureStreak;
				const same =
					current?.workUnitId === event.report.workUnitId &&
					current.strategyId === event.report.strategyId &&
					current.signature === event.failureSignature;
				next.failureStreak = {
					workUnitId: event.report.workUnitId,
					strategyId: event.report.strategyId,
					signature: event.failureSignature,
					count: same ? current.count + 1 : 1,
					escalated: same ? current.escalated : false,
				};
			}
			break;
		}
		case "usage_recorded":
			if (event.tokens < 0 || event.costUsd < 0) throw new Error("usage cannot be negative");
			next.totalTokens += event.tokens;
			next.totalCostUsd += event.costUsd;
			break;
		case "context_observed":
			if (!previous.sessions.some((session) => session.id === event.sessionId)) {
				throw new Error(`context observed for unknown session: ${event.sessionId}`);
			}
			if (event.sessionId === previous.activeSessionId) {
				next.context = { tokens: event.tokens, contextWindow: event.contextWindow };
			}
			break;
		case "failure_recorded": {
			const same =
				previous.failureStreak?.workUnitId === event.workUnitId &&
				previous.failureStreak.strategyId === event.strategyId &&
				previous.failureStreak.signature === event.signature;
			next.failureStreak = {
				workUnitId: event.workUnitId,
				strategyId: event.strategyId,
				signature: event.signature,
				count: same ? previous.failureStreak!.count + 1 : 1,
				escalated: same ? previous.failureStreak!.escalated : false,
			};
			break;
		}
		case "failure_reset":
			if (previous.failureStreak?.workUnitId === event.workUnitId) next.failureStreak = undefined;
			break;
		case "escalation_completed":
			if (
				previous.failureStreak?.workUnitId !== event.workUnitId ||
				previous.failureStreak.signature !== event.signature ||
				previous.failureStreak.count <= config.limits.failureThreshold ||
				previous.failureStreak.escalated
			) {
				throw new Error("escalation does not match an eligible un-escalated failure streak");
			}
			if (previous.escalations >= config.limits.maxEscalations) throw new Error("escalation limit exhausted");
			next.escalations++;
			next.failureStreak = { ...previous.failureStreak, escalated: true };
			break;
		case "acceptance_recorded":
			break;
		case "blocked":
			requireTransition(previous.phase, "blocked");
			next.phase = "blocked";
			next.blockedReason = event.reason;
			break;
		case "terminal":
			requireTransition(previous.phase, event.phase);
			next.phase = event.phase;
			next.blockedReason = event.reason;
			next.pendingControl = undefined;
			break;
		default:
			throw new Error(`unknown journal event type: ${String((event as { type?: unknown }).type)}`);
	}
	return next;
}

export function replayJournal(records: JournalRecord[], config: LongHorizonRunConfig): RunState {
	if (records.length === 0) throw new Error("journal is empty");
	return records.reduce<RunState | undefined>(
		(state, record) => applyJournalRecord(state, record, config),
		undefined,
	)!;
}

export type NextAction = "stop" | "pause" | "abort" | "fail-budget" | "plan" | "reconcile" | "execute";

export function selectNextAction(state: RunState, config: LongHorizonRunConfig, now = Date.now()): NextAction {
	if (isTerminalPhase(state.phase)) return "stop";
	if (state.pendingControl === "abort") return "abort";
	if (state.pendingControl === "pause") return "pause";
	if (state.pendingEffect) return "reconcile";
	if (
		state.rounds >= config.limits.maxRounds ||
		state.totalTokens >= config.limits.maxTotalTokens ||
		state.totalCostUsd >= config.limits.maxCostUsd ||
		now - Date.parse(config.createdAt) >= config.limits.maxElapsedMs
	) {
		return "fail-budget";
	}
	if (state.phase === "created" || state.phase === "planning") return "plan";
	if (state.phase === "paused" || state.phase === "blocked") return "stop";
	return "execute";
}
