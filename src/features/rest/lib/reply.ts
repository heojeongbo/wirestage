import type { AbortErrorCode } from "../../../entities/plugin/index.js";
import type { RestReply, RestStream } from "../model/types.js";

export interface ReplyInit {
	readonly status?: number;
	readonly headers?: Readonly<Record<string, string>>;
}

const response = (
	body: Uint8Array | string | undefined,
	contentType: string | undefined,
	init: ReplyInit,
	defaultStatus: number,
): RestReply => ({
	kind: "response",
	status: init.status ?? defaultStatus,
	headers: {
		...(contentType === undefined ? {} : { "content-type": contentType }),
		...init.headers,
	},
	...(body === undefined ? {} : { body }),
});

/** A JSON body. A bigint field (protobuf int64) is written as a string. */
export function json(value: unknown, init: ReplyInit = {}): RestReply {
	return response(
		JSON.stringify(value, (_key, v: unknown) =>
			typeof v === "bigint" ? v.toString() : v,
		),
		"application/json",
		init,
		200,
	);
}

export function text(value: string, init: ReplyInit = {}): RestReply {
	return response(value, "text/plain; charset=utf-8", init, 200);
}

export function bytes(
	value: Uint8Array,
	init: ReplyInit & { readonly contentType?: string } = {},
): RestReply {
	return response(
		value,
		init.contentType ?? "application/octet-stream",
		init,
		200,
	);
}

/**
 * A response that stays open — a watch, a log that follows, a long poll —
 * written by `open` at the test's pace, then ended or cut. The head goes
 * out before `open` runs, so an `open` that throws cuts the connection.
 */
export function stream(
	open: (stream: RestStream) => void | Promise<void>,
	init: ReplyInit & { readonly contentType?: string } = {},
): RestReply {
	return {
		kind: "stream",
		status: init.status ?? 200,
		headers: {
			"content-type": init.contentType ?? "application/octet-stream",
			...init.headers,
		},
		open,
	};
}

/** No body. 204 unless `status` says otherwise. */
export function empty(init: ReplyInit = {}): RestReply {
	return response(undefined, undefined, init, 204);
}

/**
 * Decline to answer: the request goes on to the next route that matches it,
 * and to the real server when there is none. A route that only watches —
 * `route.next()`, `route.requests` — answers with this.
 */
export function passthrough(): RestReply {
	return { kind: "passthrough" };
}

/** Fail the request at the network level, as a dropped connection would. */
export function abort(error: AbortErrorCode = "failed"): RestReply {
	return { kind: "abort", error };
}

/** Answer `reply`, `ms` later. (Not named `then`, so a reply never looks like a thenable.) */
export function delay(ms: number, reply: RestReply): RestReply {
	return { kind: "delay", ms, reply };
}
