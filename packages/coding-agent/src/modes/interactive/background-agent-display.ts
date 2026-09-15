import type { BackgroundAgentInfo } from "../../core/tools/subagent.js";

function compactNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

function truncate(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

export function formatBackgroundAgentRow(agent: Readonly<BackgroundAgentInfo>, width = 120): string {
	const status = agent.status === "running" ? "running" : agent.status;
	const model = [agent.provider, agent.model].filter(Boolean).join("/") || "model pending";
	const thinking = agent.thinking ? ` @ ${agent.thinking}` : "";
	const usage = agent.usage;
	const metrics = `in ${compactNumber(usage.input)} · out ${compactNumber(usage.output)} · cache ${compactNumber(usage.cacheRead)}/${compactNumber(usage.cacheWrite)} · $${usage.cost.toFixed(4)}`;
	const hierarchy = agent.parentAgentId ? "↳ " : "";
	const fixed = `${hierarchy}[${status}] ${agent.agentType} —  | ${metrics} | ${model}${thinking}`;
	const taskWidth = Math.max(8, width - fixed.length);
	return `${hierarchy}[${status}] ${agent.agentType} — ${truncate(agent.taskSummary, taskWidth)} | ${metrics} | ${model}${thinking}`;
}
