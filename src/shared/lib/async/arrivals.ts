import type { Clock } from "../clock/index.js";
import { WirestageError } from "../errors/index.js";

export interface ArrivalWaitOptions {
	/** Milliseconds to wait. Defaults to the value given at creation. */
	readonly timeout?: number;
}

export interface Arrivals<T> {
	push(item: T): void;
	/**
	 * The next item `next` has not returned yet, waiting for one if needed.
	 * Items that arrived before the call count: a test that asks for the stream
	 * the page opened during `goto` must not miss it by asking too late.
	 */
	next(options?: ArrivalWaitOptions): Promise<T>;
	readonly items: readonly T[];
	readonly latest: T | undefined;
}

export interface ArrivalsOptions {
	readonly clock: Clock;
	/** Names the thing being waited for in the TIMEOUT message. */
	readonly label: string;
	readonly timeout?: number;
	/**
	 * What the waiter knows about why nothing arrived, added to the TIMEOUT
	 * message: "the page never asked" and "it asked, and the answer got
	 * lost" call for different fixes.
	 */
	readonly hint?: () => string | undefined;
}

/** Things that show up over time — connections, calls, messages — and a way to await the next. */
export function createArrivals<T>(options: ArrivalsOptions): Arrivals<T> {
	const items: T[] = [];
	let cursor = 0;
	const waiters = new Set<() => void>();
	const defaultTimeout = options.timeout ?? 5_000;

	/** Resolves true on the next push, false when `ms` pass first. */
	const pushedWithin = async (ms: number): Promise<boolean> => {
		const abort = new AbortController();
		let resolvePushed!: (pushed: boolean) => void;
		const pushed = new Promise<boolean>((resolve) => {
			resolvePushed = resolve;
		});
		const wake = () => resolvePushed(true);
		waiters.add(wake);
		const expired = options.clock
			.sleep(ms, abort.signal)
			.then(() => false)
			.catch(() => true);
		const result = await Promise.race([pushed, expired]);
		waiters.delete(wake);
		abort.abort();
		return result;
	};

	return {
		push(item) {
			items.push(item);
			for (const wake of [...waiters]) wake();
		},
		async next(waitOptions = {}) {
			const timeout = waitOptions.timeout ?? defaultTimeout;
			const deadline = options.clock.now() + timeout;
			// A loop, not a single wait: two callers woken by one push race for
			// one item, and the loser has to go back to waiting.
			for (;;) {
				if (cursor < items.length) return items[cursor++] as T;
				const remaining = deadline - options.clock.now();
				if (remaining <= 0 || !(await pushedWithin(remaining))) {
					if (cursor < items.length) return items[cursor++] as T;
					const hint = options.hint?.();
					throw new WirestageError(
						"TIMEOUT",
						`no ${options.label} arrived within ${timeout} ms (${items.length} seen so far)${hint === undefined ? "" : `; ${hint}`}`,
						{ details: { label: options.label, timeout, seen: items.length } },
					);
				}
			}
		},
		get items() {
			return items;
		},
		get latest() {
			return items.at(-1);
		},
	};
}
