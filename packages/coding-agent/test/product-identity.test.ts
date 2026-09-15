import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	APP_NAME,
	CLI_NAME,
	COMPATIBILITY_NAME,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	ENV_PREFIX,
	getAgentDir,
	getDebugLogPath,
	getSecretsDir,
	PRODUCT_NAME,
} from "../src/config.js";

const originalAgentDir = process.env.DREB_CODING_AGENT_DIR;

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.DREB_CODING_AGENT_DIR;
	else process.env.DREB_CODING_AGENT_DIR = originalAgentDir;
});

describe("Pierre Dreb product identity", () => {
	it("separates display and command identity from retained compatibility names", () => {
		expect(PRODUCT_NAME).toBe("Pierre Dreb");
		expect(APP_NAME).toBe(PRODUCT_NAME);
		expect(CLI_NAME).toBe("pierre-dreb");
		expect(COMPATIBILITY_NAME).toBe("dreb");
		expect(CONFIG_DIR_NAME).toBe(".dreb");
		expect(ENV_PREFIX).toBe("DREB");
		expect(ENV_AGENT_DIR).toBe("DREB_CODING_AGENT_DIR");
	});

	it("keeps legacy config, secret, and debug paths", () => {
		const agentDir = join(homedir(), "tmp", "pierre-dreb-identity-test");
		process.env.DREB_CODING_AGENT_DIR = agentDir;

		expect(getAgentDir()).toBe(agentDir);
		expect(getDebugLogPath()).toBe(join(agentDir, "dreb-debug.log"));
		expect(getSecretsDir()).toBe(join(homedir(), ".dreb", "secrets"));
	});

	it("maps the canonical and compatibility commands to one compiled entry point", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
			bin?: Record<string, string>;
		};

		expect(pkg.bin?.["pierre-dreb"]).toBe("dist/cli.js");
		expect(pkg.bin?.dreb).toBe(pkg.bin?.["pierre-dreb"]);
	});
});
