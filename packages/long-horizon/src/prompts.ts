import type { HandoffArtifact, LongHorizonRunConfig, SolAdvice, SolPlan, TerraRoundReport } from "./types.js";

const AUTHORITY = `The workspace and deterministic command evidence are authoritative. Never claim success without evidence. Do not ask questions; if human input is essential, report blocked.`;

export function planningPrompt(config: LongHorizonRunConfig): string {
	return `${AUTHORITY}\nCreate a bounded implementation plan for this objective:\n${config.objective}\n\nReturn only <dreb-plan>{"schemaVersion":1,"objective":"...","workUnits":[{"id":"stable-id","title":"...","acceptance":["..."]}],"acceptanceCriteria":["..."],"constraints":["..."]}</dreb-plan>.`;
}

export function initialExecutionPrompt(config: LongHorizonRunConfig, plan: SolPlan): string {
	return `${AUTHORITY}\nObjective:\n${config.objective}\n\nValidated plan:\n${JSON.stringify(plan)}\n\nWork autonomously on one coherent work unit. End with exactly one <dreb-report> JSON object using schemaVersion 1, status progress|failed|blocked|complete|handoff_ready, stable workUnitId and strategyId, progress, evidenceIds, optional failure {operation,command,exitCode,diagnostic}, handoffReady, and nextAction.`;
}

export function continuationPrompt(previous: TerraRoundReport, wrapping: boolean, advice?: SolAdvice): string {
	return `${AUTHORITY}\nPrevious validated report:\n${JSON.stringify(previous)}${advice ? `\nAdvisor guidance:\n${JSON.stringify(advice)}` : ""}\n${wrapping ? "Context is in the wrap-up band. Finish the current coherent unit, verify where practical, leave the workspace consistent, and do not begin substantial new work." : "Continue with the next bounded action."}\nEnd with one valid <dreb-report> object.`;
}

export function escalationPrompt(config: LongHorizonRunConfig, report: TerraRoundReport, signature: string): string {
	return `${AUTHORITY}\nObjective: ${config.objective}\nCurrent work unit and exact repeated failure:\n${JSON.stringify({ report, signature })}\nGive a bounded alternative strategy. Return only <dreb-advice>{"schemaVersion":1,"workUnitId":"${report.workUnitId}","failureSignature":"${signature}","strategyId":"new-stable-strategy","advice":"..."}</dreb-advice>.`;
}

export function handoffPrompt(handoff: HandoffArtifact): string {
	return `${AUTHORITY}\nThis is a validated durable handoff from the parent session:\n${JSON.stringify(handoff)}\nContinue from the stated next action. End with one valid <dreb-report> object.`;
}

export function finalVerificationPrompt(config: LongHorizonRunConfig, plan: SolPlan, evidenceIds: string[]): string {
	return `${AUTHORITY}\nAssess whether the objective and validated plan are satisfied after deterministic acceptance passed. Objective: ${config.objective}\nPlan: ${JSON.stringify(plan)}\nAcceptance evidence IDs: ${JSON.stringify(evidenceIds)}\nReturn only <dreb-advice>{"schemaVersion":1,"workUnitId":"final","failureSignature":"none","strategyId":"accept" or "reject","advice":"concise assessment"}</dreb-advice>.`;
}
