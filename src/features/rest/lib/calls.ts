import type { Frame } from "../../../entities/frame/index.js";
import type { RestCall, RestPath } from "../model/types.js";
import { compilePath } from "./path.js";

export interface CallFilter {
	readonly method?: string;
	readonly path?: RestPath;
}

/** The calls of `frames` a `calls()` filter asks for. */
export function filterCalls(
	frames: readonly Frame[],
	filter: CallFilter,
	baseURL: string | undefined,
): RestCall[] {
	const matcher =
		filter.path === undefined ? undefined : compilePath(filter.path, baseURL);
	const wanted = filter.method?.toUpperCase();
	return assembleCalls(frames).filter(
		(call) =>
			(wanted === undefined || wanted === call.method) &&
			(matcher === undefined || matcher.match(new URL(call.url)) !== undefined),
	);
}

/**
 * Pair each recorded request with its response. One call per exchange,
 * oldest first; a frame with no correlation is an exchange of its own.
 */
export function assembleCalls(frames: readonly Frame[]): RestCall[] {
	const byCall = new Map<string, { request?: Frame; response?: Frame }>();
	for (const frame of frames) {
		// A fault, a stream's chunks and its end: what no call lists.
		if (frame.kind !== "request" && frame.kind !== "response") continue;
		const key = frame.correlation ?? `#${frame.seq}`;
		const entry = byCall.get(key) ?? {};
		entry[frame.kind] = frame;
		byCall.set(key, entry);
	}
	const calls: RestCall[] = [];
	for (const [correlation, { request, response }] of byCall) {
		if (request === undefined) continue;
		const status = response?.meta["status"];
		calls.push({
			correlation,
			method: String(request.meta["method"]),
			url: String(request.meta["url"]),
			request,
			response,
			status: typeof status === "number" ? status : undefined,
			server:
				typeof request.meta["server"] === "string"
					? request.meta["server"]
					: undefined,
		});
	}
	return calls;
}
