import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { type Model, supportsMax, supportsXhigh } from "@dreb/ai";
import { assertCommandAuthorized, parseCommand } from "./policy.js";
import type { LongHorizonRunConfig, ModelSelection } from "./types.js";

export type RunConfigInput = Omit<
	LongHorizonRunConfig,
	"schemaVersion" | "runId" | "createdAt" | "cwd" | "runRoot" | "limits" | "rollover" | "policy"
> & {
	runId?: string;
	cwd?: string;
	runRoot?: string;
	limits?: Partial<LongHorizonRunConfig["limits"]>;
	rollover?: Partial<LongHorizonRunConfig["rollover"]>;
	policy?: Partial<LongHorizonRunConfig["policy"]>;
};

const DEFAULT_LIMITS: LongHorizonRunConfig["limits"] = {
	maxRounds: 100,
	maxTotalTokens: 5_000_000,
	maxCostUsd: 500,
	maxElapsedMs: 7 * 24 * 60 * 60 * 1000,
	maxHandoffs: 20,
	maxEscalations: 10,
	maxUnchangedFailureCycles: 8,
	failureThreshold: 3,
};

const DEFAULT_ROLLOVER: LongHorizonRunConfig["rollover"] = {
	softTokens: 250_000,
	strongTokens: 300_000,
};

const DEFAULT_POLICY: LongHorizonRunConfig["policy"] = {
	allowedCommands: [],
	allowDestructiveGit: false,
	allowRelease: false,
	allowDeploy: false,
	allowCredentials: false,
	allowRemoteState: false,
	commandTimeoutMs: 10 * 60 * 1000,
	maxOutputBytes: 64 * 1024,
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const COUNT_LIMITS = new Set([
	"maxRounds",
	"maxHandoffs",
	"maxEscalations",
	"maxUnchangedFailureCycles",
	"failureThreshold",
]);

function assertKnownKeys(name: string, value: unknown, allowed: readonly string[]): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	const allowedKeys = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
	if (unknown.length > 0) throw new Error(`${name} contains unknown fields: ${unknown.join(", ")}`);
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

function assertPositive(name: string, value: number): void {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
}

function validateSelection(name: string, selection: ModelSelection): void {
	assertKnownKeys(name, selection, ["provider", "modelId", "thinkingLevel"]);
	if (typeof selection.provider !== "string" || typeof selection.modelId !== "string") {
		throw new Error(`${name} requires provider and modelId`);
	}
	if (!selection.provider.trim() || !selection.modelId.trim())
		throw new Error(`${name} requires provider and modelId`);
	if (typeof selection.thinkingLevel !== "string" || !THINKING_LEVELS.has(selection.thinkingLevel)) {
		throw new Error(`${name}.thinkingLevel is invalid`);
	}
	if (selection.thinkingLevel === "off") throw new Error(`${name} must use a reasoning thinking level`);
}

export function validateThinkingCapability(selection: ModelSelection, model: Model<any>): void {
	if (model.provider !== selection.provider || model.id !== selection.modelId) {
		throw new Error(`Resolved model mismatch for ${selection.provider}/${selection.modelId}`);
	}
	if (!model.reasoning) throw new Error(`${selection.provider}/${selection.modelId} does not support reasoning`);
	if (selection.thinkingLevel === "max" && !supportsMax(model)) {
		throw new Error(`${selection.provider}/${selection.modelId} does not support max thinking`);
	}
	if (selection.thinkingLevel === "xhigh" && !supportsXhigh(model)) {
		throw new Error(`${selection.provider}/${selection.modelId} does not support xhigh thinking`);
	}
}

export function normalizeRunConfig(input: RunConfigInput): LongHorizonRunConfig {
	assertKnownKeys("configuration", input, [
		"schemaVersion",
		"runId",
		"objective",
		"cwd",
		"runRoot",
		"planner",
		"executor",
		"advisor",
		"verifier",
		"acceptanceCommands",
		"limits",
		"rollover",
		"policy",
		"createdAt",
	]);
	if (typeof input.objective !== "string" || !input.objective.trim()) throw new Error("objective is required");
	validateSelection("planner", input.planner);
	validateSelection("executor", input.executor);
	validateSelection("advisor", input.advisor);
	if (input.verifier !== undefined) validateSelection("verifier", input.verifier);
	if (input.runId !== undefined && typeof input.runId !== "string") throw new Error("runId must be a string");
	if (input.cwd !== undefined && typeof input.cwd !== "string") throw new Error("cwd must be a string");
	if (input.runRoot !== undefined && typeof input.runRoot !== "string") throw new Error("runRoot must be a string");
	if (
		!Array.isArray(input.acceptanceCommands) ||
		input.acceptanceCommands.some((command) => typeof command !== "string")
	) {
		throw new Error("acceptanceCommands must be a string array");
	}
	if (input.limits !== undefined) assertKnownKeys("limits", input.limits, Object.keys(DEFAULT_LIMITS));
	if (input.rollover !== undefined) assertKnownKeys("rollover", input.rollover, Object.keys(DEFAULT_ROLLOVER));
	if (input.policy !== undefined) assertKnownKeys("policy", input.policy, Object.keys(DEFAULT_POLICY));
	if (input.policy?.allowedCommands !== undefined && !Array.isArray(input.policy.allowedCommands)) {
		throw new Error("policy.allowedCommands must be a string array");
	}
	const cwd = resolve(input.cwd ?? process.cwd());
	const runRoot = resolve(input.runRoot ?? resolve(cwd, ".dreb", "long-runs"));
	const limits = { ...DEFAULT_LIMITS, ...input.limits };
	const rollover = { ...DEFAULT_ROLLOVER, ...input.rollover };
	const policy = {
		...DEFAULT_POLICY,
		...input.policy,
		allowedCommands: [
			...new Set(
				(input.policy?.allowedCommands ?? []).map((command) => {
					if (typeof command !== "string") throw new Error("policy.allowedCommands must be a string array");
					return command.trim();
				}),
			),
		],
	};
	if (policy.allowedCommands.some((command) => !command)) throw new Error("policy commands must be non-empty");
	for (const [name, value] of Object.entries(limits)) {
		assertPositive(`limits.${name}`, value);
		if (COUNT_LIMITS.has(name) && !Number.isSafeInteger(value)) throw new Error(`limits.${name} must be an integer`);
	}
	assertPositive("rollover.softTokens", rollover.softTokens);
	assertPositive("rollover.strongTokens", rollover.strongTokens);
	if (rollover.softTokens >= rollover.strongTokens) {
		throw new Error("rollover.softTokens must be less than rollover.strongTokens");
	}
	assertPositive("policy.commandTimeoutMs", policy.commandTimeoutMs);
	assertPositive("policy.maxOutputBytes", policy.maxOutputBytes);
	for (const name of [
		"allowDestructiveGit",
		"allowRelease",
		"allowDeploy",
		"allowCredentials",
		"allowRemoteState",
	] as const) {
		if (typeof policy[name] !== "boolean") throw new Error(`policy.${name} must be a boolean`);
	}
	const acceptanceCommands = [...new Set(input.acceptanceCommands.map((command) => command.trim()))];
	if (acceptanceCommands.length === 0 || acceptanceCommands.some((command) => !command)) {
		throw new Error("at least one non-empty acceptance command is required");
	}
	for (const command of policy.allowedCommands) assertCommandAuthorized(command, policy);
	for (const command of acceptanceCommands) {
		parseCommand(command);
		assertCommandAuthorized(command, { ...policy, allowedCommands: [...policy.allowedCommands, command] });
	}
	return deepFreeze({
		schemaVersion: 1,
		runId: input.runId?.trim() || randomUUID(),
		objective: input.objective.trim(),
		cwd,
		runRoot,
		planner: { ...input.planner },
		executor: { ...input.executor },
		advisor: { ...input.advisor },
		verifier: input.verifier ? { ...input.verifier } : undefined,
		acceptanceCommands,
		limits,
		rollover,
		policy,
		createdAt: new Date().toISOString(),
	});
}

export function parseRunConfig(value: unknown): LongHorizonRunConfig {
	if (!value || typeof value !== "object") throw new Error("configuration must be an object");
	const raw = value as Partial<LongHorizonRunConfig>;
	if (raw.schemaVersion !== 1) throw new Error(`unsupported configuration schema: ${String(raw.schemaVersion)}`);
	if (!raw.runId || !raw.createdAt || !Number.isFinite(Date.parse(raw.createdAt))) {
		throw new Error("persisted configuration requires runId and a valid createdAt timestamp");
	}
	const normalized = normalizeRunConfig(raw as RunConfigInput);
	return deepFreeze({ ...normalized, runId: raw.runId, createdAt: raw.createdAt });
}
