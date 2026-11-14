import type { Frame } from "../../../entities/frame/index.js";
import type { RestCall } from "../model/types.js";

/**
 * Pair each recorded request with how it ended. One call per exchange,
 * oldest first; a frame with no correlation is an exchange of its own.
 */
export function assembleCalls(frames: readonly Frame[]): RestCall[] {
	const byCall = new Map<string, { request?: Frame; end?: Frame }>();
	for (const frame of frames) {
		const key = frame.correlation ?? `#${frame.seq}`;
		const entry = byCall.get(key) ?? {};
		if (frame.kind === "request") entry.request = frame;
		else entry.end = frame;
		byCall.set(key, entry);
	}
	const calls: RestCall[] = [];
	for (const [correlation, { request, end }] of byCall) {
		if (request === undefined) continue;
		const status = end?.meta["status"];
		calls.push({
			correlation,
			method: String(request.meta["method"]),
			url: String(request.meta["url"]),
			request,
			response: end?.kind === "response" ? end : undefined,
			status: typeof status === "number" ? status : undefined,
		});
	}
	return calls;
}
