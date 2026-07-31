import { Agent } from "@dreb/agent-core";
import { findModel } from "@dreb/ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

type RunnerDouble = {
	hasHandlers: ReturnType<typeof vi.fn>;
	emit: ReturnType<typeof vi.fn>;
	getFlagValues: ReturnType<typeof vi.fn>;
};

function createRunner(): RunnerDouble {
	return {
		hasHandlers: vi.fn((eventType: string) => eventType === "session_shutdown"),
		emit: vi.fn(async () => {}),
		getFlagValues: vi.fn(() => new Map()),
	};
}

function createSession(): AgentSession {
	const authStorage = AuthStorage.inMemory();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: findModel("anthropic", "sonnet")!,
			systemPrompt: "Test.",
			tools: [],
		},
	});
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: new ModelRegistry(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("AgentSession.dispose", () => {
	it("awaits extension shutdown before unsubscribing listeners and disconnecting", async () => {
		const session = createSession();
		const order: string[] = [];
		let finishShutdown: () => void;
		const shutdownFinished = new Promise<void>((resolve) => {
			finishShutdown = resolve;
		});
		const runner = createRunner();
		runner.emit.mockImplementation(async () => {
			order.push("shutdown");
			await shutdownFinished;
			order.push("shutdown-finished");
		});

		const internals = session as any;
		internals._extensionRunner = runner;
		internals._extensionErrorUnsubscriber = () => order.push("unsubscribe-extension-errors");
		vi.spyOn(internals, "_disconnectFromAgent").mockImplementation(() => order.push("disconnect-agent"));

		const disposing = session.dispose();
		await Promise.resolve();
		expect(order).toEqual(["shutdown"]);

		finishShutdown!();
		await disposing;

		expect(order).toEqual(["shutdown", "shutdown-finished", "unsubscribe-extension-errors", "disconnect-agent"]);
		expect(internals._extensionRunner).toBeUndefined();
		expect(internals._extensionErrorUnsubscriber).toBeUndefined();
	});

	it("shares one cleanup promise and emits shutdown once for concurrent callers", async () => {
		const session = createSession();
		const runner = createRunner();
		(session as any)._extensionRunner = runner;

		const first = session.dispose();
		const second = session.dispose();

		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(runner.emit).toHaveBeenCalledTimes(1);
		expect(runner.emit).toHaveBeenCalledWith({ type: "session_shutdown" }, { throwOnError: true });
	});

	it("shuts down each reload runtime once", async () => {
		const session = createSession();
		const oldRunner = createRunner();
		const newRunner = createRunner();
		const internals = session as any;
		internals._extensionRunner = oldRunner;
		vi.spyOn(internals, "_buildRuntime").mockImplementation(() => {
			internals._extensionRunner = newRunner;
		});

		await session.reload();
		expect(oldRunner.emit).toHaveBeenCalledTimes(1);

		await session.dispose();
		expect(oldRunner.emit).toHaveBeenCalledTimes(1);
		expect(newRunner.emit).toHaveBeenCalledTimes(1);
		expect(newRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown" }, { throwOnError: true });
	});

	it("shares an extension runtime shutdown promise", async () => {
		const session = createSession();
		const runner = createRunner();
		let finishShutdown: () => void;
		const shutdownFinished = new Promise<void>((resolve) => {
			finishShutdown = resolve;
		});
		runner.emit.mockImplementation(() => shutdownFinished);

		const internals = session as any;
		const first = internals._shutdownExtensionRuntime(runner);
		const second = internals._shutdownExtensionRuntime(runner);

		expect(second).toBe(first);
		expect(runner.emit).toHaveBeenCalledTimes(1);
		finishShutdown!();
		await Promise.all([first, second]);
	});

	it("shares a rejecting extension runtime shutdown promise", async () => {
		const session = createSession();
		const runner = createRunner();
		const shutdownError = new Error("shutdown failed");
		runner.emit.mockRejectedValue(shutdownError);
		const internals = session as any;

		const first = internals._shutdownExtensionRuntime(runner);
		const second = internals._shutdownExtensionRuntime(runner);

		expect(second).toBe(first);
		expect(runner.emit).toHaveBeenCalledOnce();
		await expect(first).rejects.toBe(shutdownError);
		await expect(second).rejects.toBe(shutdownError);
	});

	it("rejects shared disposal after a shutdown failure while still releasing local resources", async () => {
		const session = createSession();
		const runner = createRunner();
		const shutdownError = new Error("shutdown failed");
		runner.emit.mockRejectedValue(shutdownError);
		const internals = session as any;
		const runnerRef = { current: runner };
		const unsubscribeExtensionErrors = vi.fn();
		const disconnect = vi.spyOn(internals, "_disconnectFromAgent");
		const disposePerformanceTracker = vi.spyOn(internals.performanceTracker, "dispose");
		internals._extensionRunner = runner;
		internals._extensionRunnerRef = runnerRef;
		internals._extensionErrorUnsubscriber = unsubscribeExtensionErrors;
		internals._extensionErrorListener = vi.fn();
		internals._extensionUIContext = {};
		internals._extensionCommandContextActions = {};
		internals._extensionShutdownHandler = vi.fn();
		internals._eventListeners = [vi.fn()];

		const first = session.dispose();
		const second = session.dispose();

		expect(second).toBe(first);
		await expect(first).rejects.toBe(shutdownError);
		await expect(second).rejects.toBe(shutdownError);
		expect(runner.emit).toHaveBeenCalledOnce();
		expect(unsubscribeExtensionErrors).toHaveBeenCalledOnce();
		expect(disconnect).toHaveBeenCalledOnce();
		expect(disposePerformanceTracker).toHaveBeenCalledOnce();
		expect(internals._extensionRunner).toBeUndefined();
		expect(runnerRef.current).toBeUndefined();
		expect(internals._extensionErrorUnsubscriber).toBeUndefined();
		expect(internals._extensionErrorListener).toBeUndefined();
		expect(internals._extensionUIContext).toBeUndefined();
		expect(internals._extensionCommandContextActions).toBeUndefined();
		expect(internals._extensionShutdownHandler).toBeUndefined();
		expect(internals._eventListeners).toEqual([]);
	});

	it("rejects reload before replacing resources or runtime when shutdown fails", async () => {
		const session = createSession();
		const runner = createRunner();
		const shutdownError = new Error("shutdown failed");
		runner.emit.mockRejectedValue(shutdownError);
		const internals = session as any;
		internals._extensionRunner = runner;
		const reloadSettings = vi.spyOn(session.settingsManager, "reload");
		const reloadResources = vi.spyOn(internals._resourceLoader, "reload");
		const buildRuntime = vi.spyOn(internals, "_buildRuntime");

		await expect(session.reload()).rejects.toBe(shutdownError);

		expect(runner.emit).toHaveBeenCalledOnce();
		expect(reloadSettings).not.toHaveBeenCalled();
		expect(reloadResources).not.toHaveBeenCalled();
		expect(buildRuntime).not.toHaveBeenCalled();
	});

	it("returns the dispose promise and skips reload work when disposal starts first", async () => {
		const session = createSession();
		const runner = createRunner();
		const internals = session as any;
		internals._extensionRunner = runner;
		const reloadResources = vi.spyOn(internals._resourceLoader, "reload");
		const buildRuntime = vi.spyOn(internals, "_buildRuntime");
		let finishShutdown: () => void;
		const shutdownFinished = new Promise<void>((resolve) => {
			finishShutdown = resolve;
		});
		runner.emit.mockImplementation(() => shutdownFinished);

		const disposing = session.dispose();
		const reloading = session.reload();

		expect(reloading).toBe(disposing);
		await vi.waitFor(() => expect(runner.emit).toHaveBeenCalledOnce());
		expect(reloadResources).not.toHaveBeenCalled();
		expect(buildRuntime).not.toHaveBeenCalled();

		finishShutdown!();
		await Promise.all([disposing, reloading]);

		expect(reloadResources).not.toHaveBeenCalled();
		expect(buildRuntime).not.toHaveBeenCalled();
		expect(internals._extensionRunner).toBeUndefined();
	});

	it("does not create a runtime when disposal starts during reload", async () => {
		const session = createSession();
		const oldRunner = createRunner();
		const internals = session as any;
		internals._extensionRunner = oldRunner;
		let finishShutdown: () => void;
		const shutdownFinished = new Promise<void>((resolve) => {
			finishShutdown = resolve;
		});
		oldRunner.emit.mockImplementation(() => shutdownFinished);
		const buildRuntime = vi.spyOn(internals, "_buildRuntime");

		const reloading = session.reload();
		await vi.waitFor(() => expect(oldRunner.emit).toHaveBeenCalledOnce());
		const disposing = session.dispose();
		finishShutdown!();
		await Promise.all([reloading, disposing]);

		expect(buildRuntime).not.toHaveBeenCalled();
		expect(internals._extensionRunner).toBeUndefined();
	});

	it("serializes concurrent reloads and shuts down an intermediate runtime", async () => {
		const session = createSession();
		const oldRunner = createRunner();
		const intermediateRunner = createRunner();
		const finalRunner = createRunner();
		const runners = [intermediateRunner, finalRunner];
		const internals = session as any;
		internals._extensionRunner = oldRunner;
		vi.spyOn(internals, "_buildRuntime").mockImplementation(() => {
			internals._extensionRunner = runners.shift();
		});

		await Promise.all([session.reload(), session.reload()]);

		expect(oldRunner.emit).toHaveBeenCalledTimes(1);
		expect(intermediateRunner.emit).toHaveBeenCalledTimes(1);
		expect(finalRunner.emit).not.toHaveBeenCalled();
		await session.dispose();
		expect(finalRunner.emit).toHaveBeenCalledTimes(1);
	});

	it("aborts in-flight compaction and prevents its finally reconnect from restoring subscriptions", async () => {
		const session = createSession();
		const internals = session as any;
		const runner = createRunner();
		let compactionSignal: AbortSignal | undefined;
		runner.hasHandlers.mockImplementation((eventType: string) => eventType === "session_before_compact");
		runner.emit.mockImplementation((event: { type: string; signal?: AbortSignal }) => {
			if (event.type !== "session_before_compact") return Promise.resolve();
			compactionSignal = event.signal;
			return new Promise((resolve) =>
				event.signal?.addEventListener("abort", () => resolve({ cancel: true }), { once: true }),
			);
		});
		internals._extensionRunner = runner;
		internals._modelRegistry.getApiKey = vi.fn(async () => "test-key");
		session.sessionManager.appendMessage({ role: "user", content: "Compact this", timestamp: Date.now() });
		const subscribe = vi.spyOn(session.agent, "subscribe");

		const compacting = session.compact();
		await vi.waitFor(() => expect(compactionSignal).toBeDefined());
		const disposing = session.dispose();

		await expect(compacting).rejects.toThrow("Compaction cancelled");
		await disposing;

		expect(compactionSignal?.aborted).toBe(true);
		expect(subscribe).not.toHaveBeenCalled();
		expect(internals._unsubscribeAgent).toBeUndefined();
		expect(internals._unsubscribeGuardrailSentinel).toBeUndefined();
		expect(internals._unsubscribeGuardrailCounter).toBeUndefined();
	});

	it("prevents a session switch that was waiting on an extension from reconnecting during disposal", async () => {
		const session = createSession();
		const internals = session as any;
		let finishBeforeSwitch: () => void;
		const beforeSwitch = new Promise<void>((resolve) => {
			finishBeforeSwitch = resolve;
		});
		const runner = createRunner();
		runner.hasHandlers.mockImplementation((eventType: string) => eventType === "session_before_switch");
		runner.emit.mockImplementation((event: { type: string }) =>
			event.type === "session_before_switch" ? beforeSwitch : Promise.resolve(),
		);
		internals._extensionRunner = runner;
		const subscribe = vi.spyOn(session.agent, "subscribe");

		const switching = session.switchSession("unused-session.json");
		await vi.waitFor(() =>
			expect(runner.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "session_before_switch" })),
		);
		const disposing = session.dispose();
		finishBeforeSwitch!();

		expect(await switching).toBe(false);
		await disposing;
		expect(subscribe).not.toHaveBeenCalled();
		expect(internals._unsubscribeAgent).toBeUndefined();
	});

	it("rejects new work after disposal starts without prompting or mutating the session", async () => {
		const session = createSession();
		const prompt = vi.spyOn(session.agent, "prompt");
		const appendSessionInfo = vi.spyOn(session.sessionManager, "appendSessionInfo");
		const disposing = session.dispose();

		await expect(session.prompt("must not reach a provider")).rejects.toThrow("session is disposing");
		await expect(
			session.sendCustomMessage(
				{ customType: "test", content: "must not trigger a turn", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("session is disposing");
		expect(() => session.setSessionName("must not persist")).toThrow("session is disposing");
		await disposing;

		expect(prompt).not.toHaveBeenCalled();
		expect(appendSessionInfo).not.toHaveBeenCalled();
		await expect(session.sendUserMessage("still terminal")).rejects.toThrow("session is disposing");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("drops late background-agent completion callbacks after disposal", async () => {
		const session = createSession();
		const prompt = vi.spyOn(session.agent, "prompt");
		const appendMessage = vi.spyOn(session.agent, "appendMessage");
		const appendSessionMessage = vi.spyOn(session.sessionManager, "appendMessage");
		await session.dispose();

		const result = {
			agent: "Explore",
			task: "inspect the repository",
			exitCode: 0,
			output: "late result",
			stderr: "",
			errorMessage: null,
		};
		const internals = session as any;
		internals._handleBackgroundComplete("late-success", result, false);
		internals._handleBackgroundComplete("late-cancelled", result, true);

		expect(prompt).not.toHaveBeenCalled();
		expect(appendMessage).not.toHaveBeenCalled();
		expect(appendSessionMessage).not.toHaveBeenCalled();
	});
});

describe("createAgentSession disposal", () => {
	it("awaits one real ExtensionFactory shutdown handler for concurrent SDK disposal", async () => {
		let shutdownCalls = 0;
		let finishShutdown: () => void;
		const shutdownFinished = new Promise<void>((resolve) => {
			finishShutdown = resolve;
		});
		const extensionsResult = await createTestExtensionsResult([
			(dreb) => {
				dreb.on("session_shutdown", async () => {
					shutdownCalls++;
					await shutdownFinished;
				});
			},
		]);
		const { session } = await createAgentSession({
			cwd: process.cwd(),
			model: findModel("anthropic", "sonnet")!,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});

		const first = session.dispose();
		const second = session.dispose();
		let settled = false;
		void first.then(() => {
			settled = true;
		});

		expect(second).toBe(first);
		await vi.waitFor(() => expect(shutdownCalls).toBe(1));
		await Promise.resolve();
		expect(settled).toBe(false);

		finishShutdown!();
		await Promise.all([first, second]);
		expect(shutdownCalls).toBe(1);
	});
});
