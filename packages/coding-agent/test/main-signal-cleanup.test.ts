import { describe, expect, it, vi } from "vitest";
import { log } from "../src/core/logger.js";
import { createSessionSignalCleanup, installSessionSignalCleanup, SIGNAL_CLEANUP_TIMEOUT_MS } from "../src/main.js";

describe("createSessionSignalCleanup", () => {
	it("awaits disposal before exiting for SIGINT", async () => {
		let finishDispose: () => void;
		const disposed = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		const session = { dispose: vi.fn(() => disposed) };
		const exit = vi.fn();
		const cleanup = createSessionSignalCleanup(session, { exit });

		const shuttingDown = cleanup("SIGINT");
		await Promise.resolve();
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(exit).not.toHaveBeenCalled();

		finishDispose!();
		await shuttingDown;
		expect(exit).toHaveBeenCalledWith(130);
	});

	it("shares one cleanup promise when SIGINT and SIGTERM arrive together", async () => {
		const session = { dispose: vi.fn(async () => {}) };
		const exit = vi.fn();
		const cleanup = createSessionSignalCleanup(session, { exit });

		const first = cleanup("SIGTERM");
		const second = cleanup("SIGINT");

		expect(second).toBe(first);
		await first;
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(143);
	});

	it("waits for idempotent interactive frontend cleanup before exiting", async () => {
		let finishDispose: () => void;
		const disposed = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		let finishFrontendCleanup: () => void;
		const frontendCleaned = new Promise<void>((resolve) => {
			finishFrontendCleanup = resolve;
		});
		const session = { dispose: vi.fn(() => disposed) };
		const cleanupFrontend = vi.fn(() => frontendCleaned);
		const exit = vi.fn();
		const cleanup = createSessionSignalCleanup(session, {
			afterDispose: cleanupFrontend,
			exit,
		});

		const firstSignal = cleanup("SIGTERM");
		const concurrentSignal = cleanup("SIGINT");
		expect(concurrentSignal).toBe(firstSignal);
		await Promise.resolve();
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(cleanupFrontend).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();

		finishDispose!();
		await vi.waitFor(() => expect(cleanupFrontend).toHaveBeenCalledOnce());
		expect(exit).not.toHaveBeenCalled();

		finishFrontendCleanup!();
		await firstSignal;
		expect(cleanupFrontend).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(143);
	});

	it("bounds stuck extension cleanup, restores the frontend, and exits after the deadline", async () => {
		const logError = vi.spyOn(log, "error").mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			let finishDispose: () => void;
			const session = {
				dispose: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							finishDispose = resolve;
						}),
				),
			};
			const restoreFrontend = vi.fn();
			const exit = vi.fn();
			const cleanup = createSessionSignalCleanup(session, { afterDispose: restoreFrontend, exit });

			const shuttingDown = cleanup("SIGINT");
			await vi.advanceTimersByTimeAsync(SIGNAL_CLEANUP_TIMEOUT_MS);

			expect(session.dispose).toHaveBeenCalledOnce();
			expect(restoreFrontend).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledWith(130);
			expect(logError).toHaveBeenCalledWith(expect.stringContaining(`${SIGNAL_CLEANUP_TIMEOUT_MS}ms`));

			finishDispose!();
			await shuttingDown;
			expect(restoreFrontend).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
			logError.mockRestore();
		}
	});

	it("does not let stuck frontend restoration outlive the signal cleanup deadline", async () => {
		const logError = vi.spyOn(log, "error").mockImplementation(() => {});
		vi.useFakeTimers();
		try {
			let finishRestore: () => void;
			const restoreFrontend = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishRestore = resolve;
					}),
			);
			const exit = vi.fn();
			const cleanup = createSessionSignalCleanup(
				{ dispose: vi.fn(async () => {}) },
				{ afterDispose: restoreFrontend, exit },
			);

			const shuttingDown = cleanup("SIGTERM");
			await vi.advanceTimersByTimeAsync(SIGNAL_CLEANUP_TIMEOUT_MS);

			expect(restoreFrontend).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledWith(143);
			expect(logError).toHaveBeenCalledWith(expect.stringContaining(`${SIGNAL_CLEANUP_TIMEOUT_MS}ms`));
			finishRestore!();
			await shuttingDown;
		} finally {
			vi.useRealTimers();
			logError.mockRestore();
		}
	});

	it("exits immediately with the second signal while graceful cleanup is pending", async () => {
		let finishDispose: () => void;
		const session = {
			dispose: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishDispose = resolve;
					}),
			),
		};
		const exit = vi.fn();
		const existingSigintHandlers = new Set(process.listeners("SIGINT"));
		const existingSigtermHandlers = new Set(process.listeners("SIGTERM"));
		const remove = installSessionSignalCleanup(session, { exit });
		const sigintHandler = process.listeners("SIGINT").find((listener) => !existingSigintHandlers.has(listener));
		const sigtermHandler = process.listeners("SIGTERM").find((listener) => !existingSigtermHandlers.has(listener));

		expect(sigintHandler).toBeTypeOf("function");
		expect(sigtermHandler).toBeTypeOf("function");
		sigintHandler!("SIGINT");
		await Promise.resolve();
		expect(session.dispose).toHaveBeenCalledOnce();

		sigtermHandler!("SIGTERM");
		expect(exit).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(143);
		expect(process.listeners("SIGINT")).not.toContain(sigintHandler);

		finishDispose!();
		await Promise.resolve();
		remove();
	});

	it("installs a SIGTERM handler that cleans up before exiting", async () => {
		const existingHandlers = new Set(process.listeners("SIGTERM"));
		const session = { dispose: vi.fn(async () => {}) };
		const exit = vi.fn();
		const remove = installSessionSignalCleanup(session, { exit });
		const handler = process.listeners("SIGTERM").find((listener) => !existingHandlers.has(listener));

		expect(handler).toBeTypeOf("function");
		handler!("SIGTERM");
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
		expect(session.dispose).toHaveBeenCalledOnce();
		remove();
	});

	it("installs and removes the SIGINT listener", async () => {
		const existingHandlers = new Set(process.listeners("SIGINT"));
		const session = { dispose: vi.fn(async () => {}) };
		const exit = vi.fn();
		const remove = installSessionSignalCleanup(session, { exit });
		const handler = process.listeners("SIGINT").find((listener) => !existingHandlers.has(listener));

		expect(handler).toBeTypeOf("function");
		handler!("SIGINT");
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
		expect(session.dispose).toHaveBeenCalledOnce();
		expect(process.listeners("SIGINT")).not.toContain(handler);

		remove();
		expect(process.listeners("SIGINT")).not.toContain(handler);
	});
});
