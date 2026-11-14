/**
 * Run every step in order even when one fails, then throw what failed: the
 * one error, or an `AggregateError` of several. For teardown, where stopping
 * at the first failure leaves everything after it — a server, a route —
 * behind.
 */
export async function runAll(steps: readonly (() => unknown)[]): Promise<void> {
	const failures: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new AggregateError(failures, "several teardown steps failed");
}
