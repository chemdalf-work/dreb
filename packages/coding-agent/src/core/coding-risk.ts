export type CodingRiskLevel = "low" | "medium" | "high";

export interface CodingRiskAssessment {
	level: CodingRiskLevel;
	/** Fixed host-generated labels only; never includes raw task text. */
	signals: string[];
}

export interface CodingRiskInput {
	task: string;
	tools?: readonly string[];
}

interface RiskRule {
	signal: string;
	pattern: RegExp;
}

const STATE_CHANGING_ACTION =
	/\b(implement|build|add|change|modify|edit|fix|refactor|rewrite|remove|rotate|update|upgrade|migrate|deploy|publish|configure|grant|revoke|create|replace|set|enable|disable|delete|drop|truncate|purge|destroy|wipe)\b/i;
const BOUNDED_RESEARCH_INTENT =
	/^\s*(?:please\s+)?(?:find|locate|search|inspect|investigate|research|look up|list|summari[sz]e|explain)\b/i;
const FOLLOW_ON_MUTATION =
	/(?:[.;,:—–]\s*|-\s+|\r?\n\s*(?:[-*•]\s*)?|\b(?:and(?:\s+then)?|then)\s+)(?:please\s+)?(?:implement|build|add|change|modify|edit|fix|refactor|rewrite|remove|rotate|update|upgrade|migrate|deploy|publish|configure|grant|revoke|create|replace|set|enable|disable|delete|drop|truncate|purge|destroy|wipe)\b/i;

const HIGH_RISK_SURFACES: readonly RiskRule[] = [
	{ signal: "destructive-operation", pattern: /\b(delete|deletion|drop|truncate|purge|destroy|wipe)\b/i },
	{
		signal: "security-surface",
		pattern:
			/\b(auth(?:entication|orization)?|oauth|rbac|acls?|jwt|access[ -]control|permissions?|secrets?|credentials?|signing key|encrypt(?:ion)?|security)\b/i,
	},
	{ signal: "data-migration", pattern: /\b(database|schema|migration|persistent storage|data integrity)\b/i },
	{ signal: "concurrency", pattern: /\b(concurren(?:cy|t)|race condition|deadlock|thread safety|locking)\b/i },
	{
		signal: "protocol-compatibility",
		pattern: /\b(protocol|wire format|backward compatibility|breaking change|public api)\b/i,
	},
	{ signal: "release-surface", pattern: /\b(release|deployment|production)\b/i },
];

const MEDIUM_RISK_RULES: readonly RiskRule[] = [
	{ signal: "implementation", pattern: STATE_CHANGING_ACTION },
	{ signal: "test-change", pattern: /\b(test|spec|coverage)\b/i },
	{ signal: "documentation-change", pattern: /\b(document|documentation|readme)\b/i },
];

const LOW_RISK_RULES: readonly RiskRule[] = [
	{
		signal: "bounded-research",
		pattern: /\b(find|locate|search|inspect|investigate|research|look up|list|summari[sz]e|explain)\b/i,
	},
];

function matchingSignals(task: string, rules: readonly RiskRule[]): string[] {
	return rules.filter(({ pattern }) => pattern.test(task)).map(({ signal }) => signal);
}

export function classifyCodingRisk(input: CodingRiskInput): CodingRiskAssessment {
	const tools = new Set(input.tools ?? []);
	const writeCapable = tools.has("edit") || tools.has("write");
	const lowSignals = matchingSignals(input.task, LOW_RISK_RULES);
	const boundedReadOnly = BOUNDED_RESEARCH_INTENT.test(input.task) && !writeCapable;
	if (boundedReadOnly && !FOLLOW_ON_MUTATION.test(input.task)) return { level: "low", signals: lowSignals };

	const stateChanging = STATE_CHANGING_ACTION.test(input.task);
	const highSignals = stateChanging ? matchingSignals(input.task, HIGH_RISK_SURFACES) : [];
	if (highSignals.length > 0) return { level: "high", signals: [...new Set(highSignals)] };

	const mediumSignals = matchingSignals(input.task, MEDIUM_RISK_RULES);
	if (writeCapable) mediumSignals.push("write-capable-profile");
	if (mediumSignals.length > 0) return { level: "medium", signals: [...new Set(mediumSignals)] };

	return { level: "medium", signals: ["unclassified"] };
}
