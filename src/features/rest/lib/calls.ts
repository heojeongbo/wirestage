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
			server:
				typeof request.meta["server"] === "string"
					? request.meta["server"]
					: undefined,
		});
	}
	return calls;
}
