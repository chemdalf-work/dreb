import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("InteractiveMode.shutdown", () => {
	it("awaits disposal once before draining terminal input, stopping, and exiting", async () => {
		const order: string[] = [];
		let finishDispose: () => void;
		const disposed = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		const context = {
			isShuttingDown: false,
			session: {
				dispose: vi.fn(() => {
					order.push("dispose");
					return disposed;
				}),
			},
			ui: {
				terminal: {
					drainInput: vi.fn(async () => {
						order.push("drain-input");
					}),
				},
			},
			stop: vi.fn(() => {
				order.push("stop-terminal");
			}),
		};
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			order.push(`exit:${code}`);
		}) as never);

		const shutdown = (InteractiveMode.prototype as any).shutdown.bind(context) as () => Promise<void>;
		const first = shutdown();
		const second = shutdown();

		await vi.waitFor(() => expect(context.session.dispose).toHaveBeenCalledOnce());
		expect(order).toEqual(["dispose"]);
		expect(context.ui.terminal.drainInput).not.toHaveBeenCalled();
		expect(context.stop).not.toHaveBeenCalled();
		expect(process.exit).not.toHaveBeenCalled();

		finishDispose!();
		await Promise.all([first, second]);

		expect(context.session.dispose).toHaveBeenCalledOnce();
		expect(context.ui.terminal.drainInput).toHaveBeenCalledWith(1000);
		expect(context.stop).toHaveBeenCalledOnce();
		expect(process.exit).toHaveBeenCalledWith(0);
		expect(order).toEqual(["dispose", "drain-input", "stop-terminal", "exit:0"]);
	});
});
