interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

// ---------------------------------------------------------------------------
// Backpressure-aware bounded write queue
//
// stream.write() returns false when the stream's internal buffer is full
// (backpressure). Ignoring that signal during high-rate event streaming lets
// output queue up unboundedly inside the process, which is what produced the
// multi-thousand-event end-of-response bursts in issue 448. While the stream
// is backpressured we queue subsequent writes and flush them in order on
// "drain". The queue has a hard byte cap large enough for legitimate
// multi-image dashboard bursts (issue 495); writes beyond it fail loudly
// instead of being retained. Independently, every backpressured interval has a
// watchdog so a blocked stream cannot leave flushRawStdout() waiting forever.
// ---------------------------------------------------------------------------

/** Hard maximum aggregate bytes retained by the stdout queue. */
export const MAX_QUEUED_STDOUT_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Abort if stdout stays backpressured with no drain progress for this long. */
export const MAX_NO_DRAIN_GRACE_MS = 30_000;

const FATAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS = 1_000;

const stdoutQueue: string[] = [];
let stdoutQueuedBytes = 0;
let stdoutBackpressured = false;
let stdoutDrainListening = false;
let stdoutDrainWaiters: Array<() => void> = [];
let noDrainAbortTimer: ReturnType<typeof setTimeout> | undefined;
let fatalOutputAbortStarted = false;
let fatalOutputExitTimer: ReturnType<typeof setTimeout> | undefined;

function writeToStdout(text: string): boolean {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite(text);
	}
	return process.stdout.write(text);
}

function requestDrainFlush(): void {
	if (stdoutDrainListening) return;
	stdoutDrainListening = true;
	process.stdout.once("drain", () => {
		stdoutDrainListening = false;
		// A drain proves forward progress. Give the consumer a fresh watchdog
		// window if flushing immediately encounters backpressure again.
		disarmNoDrainAbort();
		flushStdoutQueue();
	});
}

/** Start (or keep) the watchdog for the current backpressured interval. */
function armNoDrainAbort(): void {
	if (noDrainAbortTimer || fatalOutputAbortStarted) return;
	const timer = setTimeout(() => {
		noDrainAbortTimer = undefined;
		abortForStalledConsumer();
	}, MAX_NO_DRAIN_GRACE_MS);
	timer.unref();
	noDrainAbortTimer = timer;
}

function disarmNoDrainAbort(): void {
	if (!noDrainAbortTimer) return;
	clearTimeout(noDrainAbortTimer);
	noDrainAbortTimer = undefined;
}

function abortOutput(diagnostic: string): void {
	if (fatalOutputAbortStarted) return;
	fatalOutputAbortStarted = true;
	disarmNoDrainAbort();

	let exiting = false;
	const exit = (): void => {
		if (exiting) return;
		exiting = true;
		if (fatalOutputExitTimer) clearTimeout(fatalOutputExitTimer);
		fatalOutputExitTimer = undefined;
		process.exit(1);
	};
	fatalOutputExitTimer = setTimeout(exit, FATAL_DIAGNOSTIC_FLUSH_TIMEOUT_MS);
	fatalOutputExitTimer.unref();
	process.stderr.write(diagnostic, exit);
}

function abortForStalledConsumer(): void {
	if (!stdoutBackpressured && stdoutQueue.length === 0) return;
	abortOutput(
		`Fatal: stdout remained backpressured with ${stdoutQueuedBytes} queued bytes and no drain progress ` +
			`for ${MAX_NO_DRAIN_GRACE_MS} ms. The consumer of this process's stdout is not reading. Aborting.\n`,
	);
}

function markStdoutBackpressured(): void {
	stdoutBackpressured = true;
	requestDrainFlush();
	armNoDrainAbort();
}

function flushStdoutQueue(): void {
	stdoutBackpressured = false;
	while (stdoutQueue.length > 0) {
		const next = stdoutQueue.shift() as string;
		stdoutQueuedBytes -= Buffer.byteLength(next);
		// A false return means the stream accepted the chunk but its buffer is
		// full again — stop writing and wait for the next drain.
		if (!writeToStdout(next)) {
			markStdoutBackpressured();
			return;
		}
	}
	if (stdoutDrainWaiters.length > 0) {
		const waiters = stdoutDrainWaiters;
		stdoutDrainWaiters = [];
		for (const resolve of waiters) resolve();
	}
}

function abortForStdoutLimit(): void {
	abortOutput(
		`Fatal: stdout write queue exceeded its ${MAX_QUEUED_STDOUT_BYTES}-byte hard limit. ` +
			"Refusing unbounded memory growth. Aborting.\n",
	);
}

function enqueueStdout(text: string, bytes: number): void {
	if (bytes > MAX_QUEUED_STDOUT_BYTES - stdoutQueuedBytes) {
		abortForStdoutLimit();
		return;
	}
	stdoutQueue.push(text);
	stdoutQueuedBytes += bytes;
}

export function writeRawStdout(text: string): void {
	if (fatalOutputAbortStarted) return;
	const bytes = Buffer.byteLength(text);
	if (bytes > MAX_QUEUED_STDOUT_BYTES) {
		abortForStdoutLimit();
		return;
	}
	// Queue behind any backpressured/queued writes to preserve ordering.
	if (stdoutBackpressured || stdoutQueue.length > 0) {
		enqueueStdout(text, bytes);
		return;
	}
	if (!writeToStdout(text)) markStdoutBackpressured();
}

export async function flushRawStdout(): Promise<void> {
	// Wait for any queued output to drain so flushes observe true end-of-stream.
	if (stdoutBackpressured || stdoutQueue.length > 0) {
		await new Promise<void>((resolve) => {
			stdoutDrainWaiters.push(resolve);
		});
	}

	if (stdoutTakeoverState) {
		await new Promise<void>((resolve, reject) => {
			stdoutTakeoverState?.rawStdoutWrite("", (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		return;
	}

	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

/**
 * Test-only: clear all queue state (backlog, byte count, backpressure flag,
 * drain waiters, and the no-drain abort timer) so tests start from a clean
 * process-global slate.
 */
export function resetOutputGuardForTests(): void {
	stdoutQueue.length = 0;
	stdoutQueuedBytes = 0;
	stdoutBackpressured = false;
	stdoutDrainWaiters.length = 0;
	disarmNoDrainAbort();
	if (fatalOutputExitTimer) clearTimeout(fatalOutputExitTimer);
	fatalOutputExitTimer = undefined;
	fatalOutputAbortStarted = false;
}
