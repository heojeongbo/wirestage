import { WirestageError } from "../errors/index.js";
import { createDeferred, type Deferred } from "./deferred.js";

export interface AsyncQueue<T> extends AsyncIterable<T> {
	/**
	 * Queue a value. Resolves once the consumer has taken it and come back
	 * for the next — for a stream being written, once the value is on the
	 * wire. Rejects with `CLOSED` when the queue was closed first, or when
	 * the consumer went away before getting through the value.
	 */
	push(value: T): Promise<void>;
	/** End iteration once the queued values are consumed. */
	close(): void;
	/** End iteration with `reason` once the queued values are consumed. */
	fail(reason: unknown): void;
	readonly closed: boolean;
	/** Values pushed but not consumed yet. */
	readonly size: number;
}

interface Entry<T> {
	readonly value: T;
	readonly done: Deferred<void>;
}

/**
 * A single-consumer queue that a test pushes into and a stream implementation
 * iterates. Values pushed before the consumer starts are kept, so a test may
 * queue the first messages before the page has even opened the stream.
 */
export function createAsyncQueue<T>(): AsyncQueue<T> {
	const entries: Entry<T>[] = [];
	let waiter: (() => void) | undefined;
	let closed = false;
	let failure: { readonly reason: unknown } | undefined;
	const wake = () => {
		const w = waiter;
		waiter = undefined;
		w?.();
	};
	const lost = () =>
		new WirestageError(
			"CLOSED",
			"the queue closed before the value got through",
		);
	return {
		push(value) {
			const done = createDeferred<void>();
			if (closed) done.reject(lost());
			else {
				entries.push({ value, done });
				wake();
			}
			return done.promise;
		},
		close() {
			closed = true;
			wake();
		},
		fail(reason) {
			if (!closed) failure = { reason };
			closed = true;
			wake();
		},
		get closed() {
			return closed;
		},
		get size() {
			return entries.length;
		},
		async *[Symbol.asyncIterator]() {
			/** The value handed out last: through once the consumer is back. */
			let out: Deferred<void> | undefined;
			try {
				for (;;) {
					out?.resolve();
					out = undefined;
					const entry = entries.shift();
					if (entry !== undefined) {
						out = entry.done;
						yield entry.value;
						continue;
					}
					if (closed) {
						if (failure) throw failure.reason;
						return;
					}
					await new Promise<void>((resolve) => {
						waiter = resolve;
					});
				}
			} finally {
				// The consumer stopped early: what it held, and what it never
				// reached, did not get through.
				closed = true;
				out?.reject(lost());
				for (const entry of entries.splice(0)) entry.done.reject(lost());
			}
		},
	};
}
