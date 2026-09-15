import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import * as outputGuard from "../src/core/output-guard.js";
import * as jsonl from "../src/modes/rpc/jsonl.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runRpcMode shutdown", () => {
	it("cancels extension UI, then awaits disposal before detaching input and exiting", async () => {
		const existingEndListeners = new Set(process.stdin.listeners("end"));
		const existingErrorListeners = new Set(process.stdin.listeners("error"));
		const order: string[] = [];
		let handleInputLine: ((line: string) => void) | undefined;
		let shutdownRequested: (() => void) | undefined;
		let extensionUI: { input: (title: string, placeholder?: string) => Promise<string | undefined> } | undefined;
		let finishDispose: () => void;
		const disposed = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		const dispose = vi.fn(() => {
			order.push("dispose");
			return disposed;
		});
		const detachJsonl = vi.fn(() => {
			order.push("detach-input");
		});

		vi.spyOn(outputGuard, "takeOverStdout").mockImplementation(() => {});
		vi.spyOn(outputGuard, "writeRawStdout").mockImplementation(() => {});
		vi.spyOn(jsonl, "attachJsonlLineReader").mockImplementation((_stream, onLine) => {
			handleInputLine = onLine;
			return detachJsonl;
		});
		vi.spyOn(process.stdin, "pause").mockImplementation((() => {
			order.push("pause-input");
			return process.stdin;
		}) as never);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			order.push(`exit:${code}`);
		}) as never);

		try {
			void runRpcMode({
				sessionFile: undefined,
				messages: [],
				sessionName: undefined,
				settingsManager: { getTabTitleSettings: () => undefined },
				sessionManager: { getCwd: () => process.cwd() },
				bindExtensions: vi.fn(async (bindings) => {
					shutdownRequested = bindings.shutdownHandler;
					extensionUI = bindings.uiContext as typeof extensionUI;
				}),
				subscribe: vi.fn(() => () => {}),
				dispose,
			} as unknown as AgentSession);
			await vi.waitFor(() => expect(handleInputLine).toBeDefined());
			expect(shutdownRequested).toBeTypeOf("function");
			expect(extensionUI).toBeDefined();

			let dialogCancelled = false;
			const pendingDialog = extensionUI!.input("Confirm shutdown");
			void pendingDialog.then((value) => {
				expect(value).toBeUndefined();
				dialogCancelled = true;
				order.push("cancel-ui");
			});

			shutdownRequested!();
			handleInputLine!(JSON.stringify({ type: "get_version", id: "shutdown" }));
			await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
			await vi.waitFor(() => expect(dialogCancelled).toBe(true));
			expect(order).toEqual(["dispose", "cancel-ui"]);
			expect(detachJsonl).not.toHaveBeenCalled();
			expect(process.stdin.pause).not.toHaveBeenCalled();
			expect(process.exit).not.toHaveBeenCalled();

			finishDispose!();
			await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));

			expect(order).toEqual(["dispose", "cancel-ui", "detach-input", "pause-input", "exit:0"]);
			expect(process.stdin.listeners("end").every((listener) => existingEndListeners.has(listener))).toBe(true);
			expect(process.stdin.listeners("error").every((listener) => existingErrorListeners.has(listener))).toBe(true);
		} finally {
			for (const listener of process.stdin.listeners("end")) {
				if (!existingEndListeners.has(listener)) {
					process.stdin.off("end", listener as (...args: unknown[]) => void);
				}
			}
			for (const listener of process.stdin.listeners("error")) {
				if (!existingErrorListeners.has(listener)) {
					process.stdin.off("error", listener as (...args: unknown[]) => void);
				}
			}
		}
	});
});
