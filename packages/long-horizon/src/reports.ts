import { createHash } from "node:crypto";
import type { HandoffArtifact, SolAdvice, SolPlan, TerraRoundReport, ToolEvidence } from "./types.js";

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	name: string,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0) throw new Error(`${name} contains unknown fields: ${unknown.join(", ")}`);
	const missing = required.filter((key) => !Object.hasOwn(value, key));
	if (missing.length > 0) throw new Error(`${name} is missing fields: ${missing.join(", ")}`);
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function strings(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		throw new Error(`${name} must be a string array`);
	return value.map((item) => item.trim()).filter(Boolean);
}

export function extractStructuredJson(text: string, tag: string): unknown {
	const expression = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "g");
	const matches = [...text.matchAll(expression)];
	const candidate = matches.at(-1)?.[1] ?? text.trim();
	try {
		return JSON.parse(candidate);
	} catch (error) {
		throw new Error(`invalid ${tag} JSON: ${(error as Error).message}`);
	}
}

export function validateSolPlan(input: unknown): SolPlan {
	const value = object(input, "plan");
	exactKeys(value, "plan", ["schemaVersion", "objective", "workUnits", "acceptanceCriteria", "constraints"]);
	if (value.schemaVersion !== 1) throw new Error("unsupported plan schemaVersion");
	if (!Array.isArray(value.workUnits) || value.workUnits.length === 0)
		throw new Error("plan.workUnits must be non-empty");
	const workUnits = value.workUnits.map((raw, index) => {
		const item = object(raw, `plan.workUnits[${index}]`);
		exactKeys(item, `plan.workUnits[${index}]`, ["id", "title", "acceptance"]);
		return {
			id: string(item.id, "work unit id"),
			title: string(item.title, "work unit title"),
			acceptance: strings(item.acceptance, "work unit acceptance"),
		};
	});
	if (new Set(workUnits.map((item) => item.id)).size !== workUnits.length)
		throw new Error("work unit IDs must be unique");
	return {
		schemaVersion: 1,
		objective: string(value.objective, "plan.objective"),
		workUnits,
		acceptanceCriteria: strings(value.acceptanceCriteria, "plan.acceptanceCriteria"),
		constraints: strings(value.constraints, "plan.constraints"),
	};
}

export function parseSolPlan(text: string): SolPlan {
	return validateSolPlan(extractStructuredJson(text, "dreb-plan"));
}

export function parseTerraReport(
	text: string,
	evidence: readonly (Pick<ToolEvidence, "id" | "isError"> | { id: string; exitCode: number | null })[],
): TerraRoundReport {
	const value = object(extractStructuredJson(text, "dreb-report"), "round report");
	exactKeys(
		value,
		"round report",
		["schemaVersion", "status", "workUnitId", "strategyId", "progress", "evidenceIds", "handoffReady", "nextAction"],
		["failure"],
	);
	if (value.schemaVersion !== 1) throw new Error("unsupported round report schemaVersion");
	const status = string(value.status, "report.status") as TerraRoundReport["status"];
	if (!["progress", "complete", "blocked", "verification-failed"].includes(status))
		throw new Error(`invalid report status: ${status}`);
	const evidenceIds = strings(value.evidenceIds, "report.evidenceIds");
	const known = new Set(evidence.map((item) => item.id));
	for (const id of evidenceIds) if (!known.has(id)) throw new Error(`report references unknown evidence: ${id}`);
	let failure: TerraRoundReport["failure"];
	if (value.failure !== undefined) {
		const raw = object(value.failure, "report.failure");
		exactKeys(raw, "report.failure", ["operation", "diagnostic"], ["command", "exitCode"]);
		failure = {
			operation: string(raw.operation, "failure.operation"),
			command: typeof raw.command === "string" ? raw.command : undefined,
			exitCode: typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : undefined,
			diagnostic: string(raw.diagnostic, "failure.diagnostic"),
		};
	}
	if (status === "verification-failed" && !failure)
		throw new Error("verification-failed report requires failure details");
	if (status !== "verification-failed" && failure)
		throw new Error("only verification-failed reports may include failure details");
	if (status === "verification-failed") {
		const failedEvidence = evidence.some(
			(item) => evidenceIds.includes(item.id) && ("isError" in item ? item.isError : item.exitCode !== 0),
		);
		if (!failedEvidence) throw new Error("verification-failed report requires referenced failing tool evidence");
	}
	if (typeof value.handoffReady !== "boolean") throw new Error("report.handoffReady must be a boolean");
	return {
		schemaVersion: 1,
		status,
		workUnitId: string(value.workUnitId, "report.workUnitId"),
		strategyId: string(value.strategyId, "report.strategyId"),
		progress: string(value.progress, "report.progress"),
		evidenceIds,
		failure,
		handoffReady: value.handoffReady === true,
		nextAction: string(value.nextAction, "report.nextAction"),
	};
}

export function validateSolAdvice(input: unknown): SolAdvice {
	const value = object(input, "advice");
	exactKeys(value, "advice", ["schemaVersion", "workUnitId", "failureSignature", "strategyId", "advice"]);
	if (value.schemaVersion !== 1) throw new Error("unsupported advice schemaVersion");
	return {
		schemaVersion: 1,
		workUnitId: string(value.workUnitId, "advice.workUnitId"),
		failureSignature: string(value.failureSignature, "advice.failureSignature"),
		strategyId: string(value.strategyId, "advice.strategyId"),
		advice: string(value.advice, "advice.advice"),
	};
}

export function parseSolAdvice(text: string): SolAdvice {
	return validateSolAdvice(extractStructuredJson(text, "dreb-advice"));
}

export function validateHandoffArtifact(input: unknown): HandoffArtifact {
	const value = object(input, "handoff artifact");
	exactKeys(value, "handoff artifact", [
		"schemaVersion",
		"fromSessionId",
		"workUnitId",
		"strategyId",
		"summary",
		"nextAction",
		"evidenceIds",
		"createdAt",
	]);
	if (value.schemaVersion !== 1) throw new Error("unsupported handoff schemaVersion");
	const createdAt = string(value.createdAt, "handoff.createdAt");
	if (!Number.isFinite(Date.parse(createdAt))) throw new Error("handoff.createdAt must be a valid timestamp");
	return {
		schemaVersion: 1,
		fromSessionId: string(value.fromSessionId, "handoff.fromSessionId"),
		workUnitId: string(value.workUnitId, "handoff.workUnitId"),
		strategyId: string(value.strategyId, "handoff.strategyId"),
		summary: string(value.summary, "handoff.summary"),
		nextAction: string(value.nextAction, "handoff.nextAction"),
		evidenceIds: strings(value.evidenceIds, "handoff.evidenceIds"),
		createdAt,
	};
}

export function normalizeFailure(input: NonNullable<TerraRoundReport["failure"]>): string {
	const diagnostic = input.diagnostic
		.toLowerCase()
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/(?:[a-z]:)?[/\\][\w./-]+/gi, "<path>")
		.replace(/\b\d{4}-\d\d-\d\d[t ][\d:.+-]+z?\b/gi, "<time>")
		.replace(/\b0x[0-9a-f]+\b/gi, "<addr>")
		.replace(/\b\d{5,}\b/g, "<number>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 2000);
	const command = input.command?.trim().replace(/\s+/g, " ") ?? "";
	return createHash("sha256")
		.update(
			JSON.stringify({ operation: input.operation.trim(), command, exitCode: input.exitCode ?? null, diagnostic }),
		)
		.digest("hex");
}
