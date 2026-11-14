import type {
	IncomingMessage,
	OutgoingHttpHeader,
	ServerResponse,
} from "node:http";

import type {
	ResponseStream,
	StreamEnd,
} from "../../../entities/plugin/index.js";
import { createDeferred } from "../../../shared/lib/async/index.js";
import { toBytes } from "../../../shared/lib/bytes/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";

/** A stream as the stage serves it: the rule's end of it, and the stage's. */
export interface ServedStream {
	/** What the rule writes. */
	readonly stream: ResponseStream;
	/** The stub asked for the end, and `closed` is on its way. */
	readonly closing: boolean;
	/**
	 * The rule writing the stream failed: answer 500 with `body` while
	 * nothing has gone out, and cut the connection after. False when the
	 * response was over first — ended, cut, or let go of by the page.
	 */
	fail(body: string): boolean;
}

/**
 * A Node response as the stream a rule writes: the adapter between the
 * stream server's sockets and the plugin contract, which knows nothing of
 * Node. `onClose` hears how the response ended before `closed` resolves, so
 * whoever awaits `closed` finds the end already on record.
 */
export function createResponseStream(
	request: IncomingMessage,
	response: ServerResponse,
	onClose: (end: StreamEnd, failed: boolean) => void,
): ServedStream {
	let state: "open" | "ended" | "cut" = "open";
	let failed = false;
	const closed = createDeferred<StreamEnd>();
	response.once("close", () => {
		// Not ended and not cut: the page let go of it.
		const end = state === "open" ? "cancelled" : state;
		onClose(end, failed);
		closed.resolve(end);
	});
	/** The stream server's own headers (CORS, `connection`), before the rule's. */
	const own = Object.entries(response.getHeaders());
	/** Back to those: what a rule's head set is gone, what it replaced is back. */
	const restore = () => {
		for (const name of response.getHeaderNames()) response.removeHeader(name);
		for (const [name, value] of own)
			response.setHeader(name, value as OutgoingHttpHeader);
	};
	/**
	 * Whether a write can reach the page. Node drops a write — callback and
	 * all — into a socket destroyed or closed for writing, which is what the
	 * page letting go leaves, well before the response reports its close.
	 */
	const writable = () => state === "open" && response.socket?.writable === true;
	const requestHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(request.headers))
		requestHeaders[name] = String(value);
	return {
		stream: {
			requestHeaders,
			head(status, headers = {}) {
				// Node checks a status only as the head goes out, and refused by
				// `end()` it leaves the response broken: a 500 after it has no body.
				if (!Number.isInteger(status) || status < 100 || status > 999)
					throw new WirestageError(
						"INVALID_ARGUMENT",
						`a response status is an integer from 100 to 999, got ${status}`,
					);
				// Kept off the wire until the first write or flush, so a rule that
				// fails before then can still be answered with its 500.
				restore();
				response.statusCode = status;
				for (const [name, value] of Object.entries(headers)) {
					// The stream server's to say: one response per connection.
					if (name.toLowerCase() === "connection") continue;
					// Several values, one per line (`set-cookie`): Node sends a
					// header line for each, and refuses a value with a newline.
					const values = value.split("\n");
					response.setHeader(name, values.length > 1 ? values : value);
				}
			},
			flush() {
				response.flushHeaders();
			},
			write(chunk) {
				return new Promise<void>((resolve, reject) => {
					if (!writable()) {
						reject(
							new WirestageError("CLOSED", "the response stream is closed"),
						);
						return;
					}
					response.write(toBytes(chunk), (error) =>
						error ? reject(error) : resolve(),
					);
				});
			},
			async end() {
				if (writable()) {
					state = "ended";
					response.end();
				}
				await closed.promise;
			},
			cut() {
				if (!writable()) return;
				state = "cut";
				response.destroy();
			},
			closed: closed.promise,
		},
		get closing() {
			return state !== "open" && !closed.settled;
		},
		fail(body) {
			if (!writable()) return false;
			failed = true;
			if (response.headersSent) {
				state = "cut";
				response.destroy();
				return true;
			}
			state = "ended";
			restore();
			response
				.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
				.end(body);
			return true;
		},
	};
}
