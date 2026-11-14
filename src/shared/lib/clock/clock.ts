/**
 * Time, as a port. Waits, timeouts and frame timestamps all go through it, so a
 * unit test can drive a 5-second timeout in microseconds with a manual clock
 * instead of sleeping.
 */
export interface Clock {
	/** Milliseconds since the Unix epoch, with sub-millisecond precision. */
	now(): number;
	/** Resolve after `ms`, or reject with the signal's reason if it aborts first. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The longest delay a Node timer takes: 2^31 - 1 ms, about 24.8 days. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Wall-clock time built from `performance`, not `Date.now()`: it has
 * sub-millisecond resolution, and a page's `performance.timeOrigin + now()` is on
 * the same scale, so page frames and Node frames sort together.
 */
export function createSystemClock(): Clock {
	return {
		now: () => performance.timeOrigin + performance.now(),
		sleep: (ms, signal) =>
			new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				const onAbort = () => {
					clearTimeout(timer);
					reject(signal?.reason);
				};
				const timer = setTimeout(
					() => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					},
					// A longer delay overflows the timer to 1 ms: "wait forever"
					// (`timeout: Infinity`) would time out at once.
					Math.min(ms, MAX_TIMER_MS),
				);
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
	};
}

export interface ManualClock extends Clock {
	/**
	 * Move time forward, resolving every sleep that falls due, earliest first.
	 * Awaiting it lets the continuations of those sleeps run before it returns.
	 */
	advance(ms: number): Promise<void>;
	/** Sleeps that have not fallen due yet. */
	readonly pending: number;
}

interface Timer {
	readonly due: number;
	readonly resolve: () => void;
}

/** A clock that only moves when told to. For tests of timing behavior. */
export function createManualClock(start = 0): ManualClock {
	let time = start;
	let timers: Timer[] = [];
	const settle = async () => {
		// Several turns: a resolved sleep's continuation may itself await
		// another promise before reaching the code under test.
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
	return {
		now: () => time,
		sleep(ms, signal) {
			return new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				const timer: Timer = {
					due: time + ms,
					resolve: () => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					},
				};
				const onAbort = () => {
					timers = timers.filter((t) => t !== timer);
					reject(signal?.reason);
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				timers.push(timer);
			});
		},
		async advance(ms) {
			const target = time + ms;
			for (;;) {
				const next = timers
					.filter((t) => t.due <= target)
					.sort((a, b) => a.due - b.due)[0];
				if (next === undefined) break;
				timers = timers.filter((t) => t !== next);
				time = next.due;
				next.resolve();
				await settle();
			}
			time = target;
			await settle();
		},
		get pending() {
			return timers.length;
		},
	};
}
