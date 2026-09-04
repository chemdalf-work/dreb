#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeRunConfig, type RunConfigInput } from "./config.js";
import { RunStore } from "./run-store.js";
import { LongHorizonSupervisor } from "./supervisor.js";

function usage(): never {
	throw new Error(
		"Usage:\n" +
			"  dreb-long-horizon start --config <file.json>\n" +
			"  dreb-long-horizon status <run-directory>\n" +
			"  dreb-long-horizon pause <run-directory> [reason]\n" +
			"  dreb-long-horizon resume <run-directory> [--acknowledge-pending] [reason]\n" +
			"  dreb-long-horizon abort <run-directory> [reason]",
	);
}

function configArgument(args: string[]): string {
	if (args.length !== 2 || args[0] !== "--config" || !args[1]) usage();
	return resolve(args[1]);
}

function runDirectory(args: string[]): string {
	if (!args[0]) usage();
	return resolve(args[0]);
}

function print(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function supervise(supervisor: LongHorizonSupervisor): Promise<void> {
	let signalHandled = false;
	const pause = (signal: string) => {
		if (signalHandled) return;
		signalHandled = true;
		try {
			supervisor.requestPause(`received ${signal}; pausing at next safe control point`);
		} catch (error) {
			process.stderr.write(`Failed to persist ${signal} pause request: ${(error as Error).message}\n`);
		}
	};
	const onSigint = () => pause("SIGINT");
	const onSigterm = () => pause("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	try {
		print(await supervisor.run());
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const [command, ...args] = argv;
	if (!command) usage();
	if (command === "start") {
		const input = JSON.parse(readFileSync(configArgument(args), "utf8")) as RunConfigInput;
		const config = normalizeRunConfig(input);
		const supervisor = LongHorizonSupervisor.create(config);
		process.stderr.write(`Created long-horizon run ${supervisor.store.runDir}\n`);
		await supervise(supervisor);
		return;
	}
	if (!["status", "pause", "resume", "abort"].includes(command)) usage();
	const directory = runDirectory(args);
	if (command === "status") {
		if (args.length !== 1) usage();
		print(LongHorizonSupervisor.open(directory).status());
		return;
	}
	if (command === "pause" || command === "abort") {
		const store = RunStore.open(directory);
		store.requestControl(command, args.slice(1).join(" ") || undefined);
		print(LongHorizonSupervisor.open(directory).status());
		return;
	}
	if (command === "resume") {
		const acknowledgePending = args.includes("--acknowledge-pending");
		const reason = args
			.slice(1)
			.filter((arg) => arg !== "--acknowledge-pending")
			.join(" ");
		const store = RunStore.open(directory);
		const pending = store.replay().pendingEffect;
		if (pending) {
			if (!acknowledgePending || !reason.trim()) {
				throw new Error(
					"run has an ambiguous pending effect; inspect it, then resume with --acknowledge-pending and an explicit reason or abort",
				);
			}
			store.acknowledgePendingEffect(reason);
		}
		const supervisor = new LongHorizonSupervisor(store);
		if (store.replay().phase === "paused" || store.replay().phase === "blocked") {
			supervisor.requestResume(reason || undefined);
		}
		await supervise(supervisor);
		return;
	}
	usage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		process.stderr.write(`Fatal: ${(error as Error).stack ?? String(error)}\n`);
		process.exitCode = 1;
	});
}
