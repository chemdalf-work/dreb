import { createHash } from "node:crypto";
import type { SolAdvice, SolPlan, TerraRoundReport, ToolEvidence } from "./types.js";

function object(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
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

export function parseSolPlan(text: string): SolPlan {
	const value = object(extractStructuredJson(text, "dreb-plan"), "plan");
	if (value.schemaVersion !== 1) throw new Error("unsupported plan schemaVersion");
	if (!Array.isArray(value.workUnits) || value.workUnits.length === 0)
		throw new Error("plan.workUnits must be non-empty");
	const workUnits = value.workUnits.map((raw, index) => {
		const item = object(raw, `plan.workUnits[${index}]`);
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

export function parseTerraReport(
	text: string,
	evidence: readonly (Pick<ToolEvidence, "id" | "isError"> | { id: string; exitCode: number | null })[],
): TerraRoundReport {
	const value = object(extractStructuredJson(text, "dreb-report"), "round report");
	if (value.schemaVersion !== 1) throw new Error("unsupported round report schemaVersion");
	const status = string(value.status, "report.status") as TerraRoundReport["status"];
	if (!["progress", "failed", "blocked", "complete", "handoff_ready"].includes(status))
		throw new Error(`invalid report status: ${status}`);
	const evidenceIds = strings(value.evidenceIds, "report.evidenceIds");
	const known = new Set(evidence.map((item) => item.id));
	for (const id of evidenceIds) if (!known.has(id)) throw new Error(`report references unknown evidence: ${id}`);
	let failure: TerraRoundReport["failure"];
	if (value.failure !== undefined) {
		const raw = object(value.failure, "report.failure");
		failure = {
			operation: string(raw.operation, "failure.operation"),
			command: typeof raw.command === "string" ? raw.command : undefined,
			exitCode: typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : undefined,
			diagnostic: string(raw.diagnostic, "failure.diagnostic"),
		};
	}
	if (status === "failed" && !failure) throw new Error("failed report requires failure details");
	if (status !== "failed" && failure) throw new Error("only failed reports may include failure details");
	if (status === "failed") {
		const failedEvidence = evidence.some(
			(item) => evidenceIds.includes(item.id) && ("isError" in item ? item.isError : item.exitCode !== 0),
		);
		if (!failedEvidence) throw new Error("failed report requires referenced failing tool evidence");
	}
	if (typeof value.handoffReady !== "boolean") throw new Error("report.handoffReady must be a boolean");
	if (status === "handoff_ready" && !value.handoffReady) {
		throw new Error("handoff_ready status requires handoffReady=true");
	}
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

export function parseSolAdvice(text: string): SolAdvice {
	const value = object(extractStructuredJson(text, "dreb-advice"), "advice");
	if (value.schemaVersion !== 1) throw new Error("unsupported advice schemaVersion");
	return {
		schemaVersion: 1,
		workUnitId: string(value.workUnitId, "advice.workUnitId"),
		failureSignature: string(value.failureSignature, "advice.failureSignature"),
		strategyId: string(value.strategyId, "advice.strategyId"),
		advice: string(value.advice, "advice.advice"),
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
