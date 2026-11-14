export interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
	readonly settled: boolean;
}

/**
 * A promise with its resolvers. Settling twice is a no-op, so racing paths
 * (a client disconnect and an explicit end) can both try without a guard.
 */
export function createDeferred<T>(): Deferred<T> {
	let settled = false;
	let resolveFn!: (value: T) => void;
	let rejectFn!: (reason: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolveFn = resolve;
		rejectFn = reject;
	});
	// A deferred nobody awaits must not surface as an unhandled rejection.
	promise.catch(() => {});
	return {
		promise,
		resolve(value) {
			if (settled) return;
			settled = true;
			resolveFn(value);
		},
		reject(reason) {
			if (settled) return;
			settled = true;
			rejectFn(reason);
		},
		get settled() {
			return settled;
		},
	};
}
