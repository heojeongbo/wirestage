import { ConnectError } from "@connectrpc/connect";

/**
 * The gRPC status a call ended with: 0 when it resolved, the server's code
 * when it failed. For asserting a refusal without a try/catch:
 *
 *     expect(await statusOf(orders.cancel(ref))).toBe(Code.PermissionDenied);
 *
 * Anything that is not a `ConnectError` -- a bug in the test, say -- is
 * rethrown rather than read as a status.
 */
export async function statusOf(call: Promise<unknown>): Promise<number> {
	try {
		await call;
		return 0;
	} catch (error) {
		if (error instanceof ConnectError) return error.code;
		throw error;
	}
}
