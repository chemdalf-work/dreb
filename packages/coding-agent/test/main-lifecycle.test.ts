import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { log } from "../src/core/logger.js";

const mocks = vi.hoisted(() => ({
	state: {
		session: undefined as Record<string, unknown> | undefined,
	},
	createAgentSession: vi.fn(),
	runPrintMode: vi.fn(async () => 0),
	runRpcMode: vi.fn(async () => {
		throw new Error("RPC mode failed");
	}),
	interactiveInit: vi.fn(async () => {}),
	interactiveRun: vi.fn(async () => {}),
	interactiveStop: vi.fn(),
}));

vi.mock("../src/core/sdk.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createAgentSession: mocks.createAgentSession,
	};
});

vi.mock("../src/modes/index.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		runPrintMode: mocks.runPrintMode,
		runRpcMode: mocks.runRpcMode,
		InteractiveMode: class {
			init = mocks.interactiveInit;
			run = mocks.interactiveRun;
			stop = mocks.interactiveStop;
		},
	};
});

vi.mock("../src/core/resource-loader.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		DefaultResourceLoader: class {
			async reload(): Promise<void> {}

			getExtensions() {
				return {
					extensions: [],
					errors: [],
					runtime: {
						pendingProviderRegistrations: [],
						flagValues: new Map(),
					},
				};
			}
		},
	};
});

function createSession(model: Record<string, unknown> | undefined) {
	return {
		model,
		thinkingLevel: "off",
		setThinkingLevel: vi.fn(),
		dispose: vi.fn(async () => {}),
	};
}

describe("main lifecycle cleanup", () => {
	let tempDir: string;
	let agentDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalBenchmark: string | undefined;
	let originalIsTTY: boolean | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		vi.resetModules();
		mocks.runPrintMode.mockClear();
		mocks.runRpcMode.mockReset();
		mocks.interactiveInit.mockReset();
		mocks.interactiveRun.mockReset();
		mocks.interactiveStop.mockReset();
		mocks.createAgentSession.mockReset();
		tempDir = join(tmpdir(), `dreb-main-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalBenchmark = process.env.DREB_STARTUP_BENCHMARK;
		originalIsTTY = process.stdin.isTTY;
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		delete process.env.DREB_STARTUP_BENCHMARK;
		process.chdir(tempDir);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalBenchmark === undefined) {
			delete process.env.DREB_STARTUP_BENCHMARK;
		} else {
			process.env.DREB_STARTUP_BENCHMARK = originalBenchmark;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("disposes a no-model session before the CLI exits", async () => {
		const session = createSession(undefined);
		mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined });
		vi.spyOn(log, "error").mockImplementation(() => {});
		const exit = new Error("exit");
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw exit;
		}) as never);
		const { main } = await import("../src/main.js");

		await expect(main(["--print", "hello"])).rejects.toBe(exit);

		expect(session.dispose).toHaveBeenCalledOnce();
		expect(mocks.runPrintMode).not.toHaveBeenCalled();
	});

	it("disposes a session when RPC mode rejects", async () => {
		const session = createSession({ id: "test", provider: "test", reasoning: false });
		mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined });
		const failure = new Error("RPC rejected");
		mocks.runRpcMode.mockRejectedValue(failure);
		const { main } = await import("../src/main.js");

		await expect(main(["--mode", "rpc"])).rejects.toBe(failure);

		expect(session.dispose).toHaveBeenCalledOnce();
	});

	it("disposes the session and stops the terminal when interactive mode rejects", async () => {
		const session = createSession({ id: "test", provider: "test", reasoning: false });
		mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined });
		const failure = new Error("interactive rejected");
		mocks.interactiveRun.mockRejectedValue(failure);
		const { main } = await import("../src/main.js");

		await expect(main([])).rejects.toBe(failure);

		expect(session.dispose).toHaveBeenCalledOnce();
		expect(mocks.interactiveStop).toHaveBeenCalledOnce();
	});

	it("awaits disposal before stopping the terminal for startup benchmarking", async () => {
		const session = createSession({ id: "test", provider: "test", reasoning: false });
		let finishDispose: () => void;
		const disposed = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		session.dispose.mockImplementation(() => disposed);
		mocks.createAgentSession.mockResolvedValue({ session, modelFallbackMessage: undefined });
		process.env.DREB_STARTUP_BENCHMARK = "1";
		const { main } = await import("../src/main.js");

		const running = main([]);
		await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
		expect(mocks.interactiveInit).toHaveBeenCalledOnce();
		expect(mocks.interactiveStop).not.toHaveBeenCalled();

		finishDispose!();
		await expect(running).resolves.toBeUndefined();
		expect(mocks.interactiveStop).toHaveBeenCalledOnce();
	});
});
