/**
 * Integration tests for AgentSession._expandSkillCommand
 *
 * Tests the private _expandSkillCommand method which is called from
 * prompt(), steer(), and followUp() to expand /skill:name commands.
 *
 * Covers: issue 45
 */

import { Agent } from "@dreb/agent-core";
import { findModel } from "@dreb/ai";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { log } from "../src/core/logger.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { createTestResourceLoader } from "./utilities.js";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const model = findModel("anthropic", "sonnet")!;

function makeSkill(overrides: Partial<Skill> & { name: string; filePath: string; baseDir: string }): Skill {
	return {
		description: "Test skill",
		sourceInfo: createSyntheticSourceInfo(overrides.filePath, { source: "test" }),
		disableModelInvocation: false,
		userInvocable: true,
		...overrides,
	};
}

const validSkill = makeSkill({
	name: "valid-skill",
	description: "A valid skill for testing.",
	filePath: resolve(fixturesDir, "valid-skill/SKILL.md"),
	baseDir: resolve(fixturesDir, "valid-skill"),
});

const substitutionSkill = makeSkill({
	name: "substitution-test",
	description: "A skill for testing content substitution.",
	filePath: resolve(fixturesDir, "substitution-test/SKILL.md"),
	baseDir: resolve(fixturesDir, "substitution-test"),
});

const nonUserInvocableSkill = makeSkill({
	name: "not-user-invocable",
	description: "A skill only the agent can invoke.",
	filePath: resolve(fixturesDir, "not-user-invocable/SKILL.md"),
	baseDir: resolve(fixturesDir, "not-user-invocable"),
	userInvocable: false,
});

const brokenSkill = makeSkill({
	name: "broken-skill",
	description: "A skill pointing to a nonexistent file.",
	filePath: resolve(fixturesDir, "nonexistent/SKILL.md"),
	baseDir: resolve(fixturesDir, "nonexistent"),
});

function createSession(skills: Skill[]) {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");

	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: new ModelRegistry(authStorage, undefined),
		resourceLoader: createTestResourceLoader({ skills }),
	});

	// Required for session to function
	session.subscribe(() => {});

	return session;
}

// Access the private method for testing
function expandSkillCommand(session: AgentSession, text: string): string {
	return (session as any)._expandSkillCommand(text);
}

describe("AgentSession._expandSkillCommand", () => {
	it("passes non-skill input through unchanged", async () => {
		const session = createSession([validSkill]);
		try {
			expect(expandSkillCommand(session, "hello world")).toBe("hello world");
			expect(expandSkillCommand(session, "/help")).toBe("/help");
			expect(expandSkillCommand(session, "/model sonnet")).toBe("/model sonnet");
			expect(expandSkillCommand(session, "")).toBe("");
		} finally {
			await session.dispose();
		}
	});

	it("expands /skill:name with no args", async () => {
		const session = createSession([validSkill]);
		try {
			const result = expandSkillCommand(session, "/skill:valid-skill");
			expect(result).toContain('<skill name="valid-skill"');
			expect(result).toContain("This is a valid skill that follows the Agent Skills standard.");
		} finally {
			await session.dispose();
		}
	});

	it("expands /skill:name with args and performs substitution", async () => {
		const session = createSession([substitutionSkill]);
		try {
			const result = expandSkillCommand(session, "/skill:substitution-test foo bar");
			expect(result).toContain('<skill name="substitution-test"');
			expect(result).toContain("Review foo in foo bar.");
			expect(result).toContain("First arg: foo, second arg: bar.");
			expect(result).toContain(`Skill dir: ${resolve(fixturesDir, "substitution-test")}.`);
			// Verify ${DREB_SESSION_ID} was substituted with a UUID
			expect(result).toMatch(/Session: [0-9a-f-]{36}\./);
			expect(result).not.toContain("$" + "{DREB_SESSION_ID}");
		} finally {
			await session.dispose();
		}
	});

	it("returns original text for unknown skill name", async () => {
		const session = createSession([validSkill]);
		try {
			const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
			const result = expandSkillCommand(session, "/skill:nonexistent");
			expect(result).toBe("/skill:nonexistent");
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown skill "nonexistent"'));
			warnSpy.mockRestore();
		} finally {
			await session.dispose();
		}
	});

	it("returns original text for unknown skill with args", async () => {
		const session = createSession([validSkill]);
		try {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const result = expandSkillCommand(session, "/skill:nonexistent some args");
			expect(result).toBe("/skill:nonexistent some args");
			consoleSpy.mockRestore();
		} finally {
			await session.dispose();
		}
	});

	it("returns original text when skill file cannot be read (error path)", async () => {
		const session = createSession([brokenSkill]);
		try {
			const warnSpy = vi.spyOn(session, "warnInSession").mockImplementation(() => {});
			const result = expandSkillCommand(session, "/skill:broken-skill");
			expect(result).toBe("/skill:broken-skill");
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skill expansion failed for "broken-skill"'));
			warnSpy.mockRestore();
		} finally {
			await session.dispose();
		}
	});

	it("returns original text when no skills are loaded", async () => {
		const session = createSession([]);
		try {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const result = expandSkillCommand(session, "/skill:anything");
			expect(result).toBe("/skill:anything");
			consoleSpy.mockRestore();
		} finally {
			await session.dispose();
		}
	});

	it("expands userInvocable: false skills (manual dispatch bypasses autocomplete filter)", async () => {
		const session = createSession([nonUserInvocableSkill]);
		try {
			// _expandSkillCommand searches all skills by name, regardless of userInvocable.
			// This is the key behavior: hidden from autocomplete but still manually invocable.
			const result = expandSkillCommand(session, "/skill:not-user-invocable");
			expect(result).toContain('<skill name="not-user-invocable"');
			expect(result).toContain("This skill is hidden from the slash command menu.");
		} finally {
			await session.dispose();
		}
	});
});
