import type {
	IncomingMessage,
	OutgoingHttpHeader,
	ServerResponse,
} from "node:http";

import { createDeferred } from "../../lib/async/index.js";
import { toBytes } from "../../lib/bytes/index.js";
import { WirestageError } from "../../lib/errors/index.js";

/**
 * How an open response ended: its writer ended it cleanly or cut it, or the
 * client let go of it (`cancelled`).
 */
export type OpenResponseEnd = "ended" | "cut" | "cancelled";

/** A response that stays open, written at its writer's pace. */
export interface OpenResponse {
	/** The request's headers as the server received them, names lower-cased. */
	readonly requestHeaders: Readonly<Record<string, string>>;
	/**
	 * Set the status and headers. They go out with the first `write`, or at
	 * once on `flush`, and a later call replaces them until then. Without a
	 * call the response is a bare 200. A header may carry several values
	 * separated by a newline (`set-cookie`). `connection` is the server's.
	 */
	head(status: number, headers?: Readonly<Record<string, string>>): void;
	/** Send the head now, before any body. */
	flush(): void;
	/**
	 * Write a chunk. Resolves once it is handed to the socket; rejects with
	 * `CLOSED` when the response is over, the client letting go included.
	 */
	write(chunk: Uint8Array | string): Promise<void>;
	/** End the response cleanly. Resolves once it is closed, as `closed` does. */
	end(): Promise<void>;
	/** Reset the connection mid-response: no terminator — a network drop. */
	cut(): void;
	/** Resolves when the response is over, with how, once `onClose` heard it. */
	readonly closed: Promise<OpenResponseEnd>;
}

/** An open response as a server holds it: the writer's end of it, and the server's. */
export interface ServedStream {
	/** What the writer writes. */
	readonly stream: OpenResponse;
	/** The writer asked for the end, and `closed` is on its way. */
	readonly closing: boolean;
	/**
	 * The writer failed: answer 500 with `body` while nothing has gone out,
	 * and cut the connection after. False when the response was over first —
	 * ended, cut, or let go of by the client.
	 */
	fail(body: string): boolean;
}

/**
 * A Node response as a stream its writer drives: the adapter between a
 * server's sockets and code that knows nothing of Node. `onClose` hears how
 * the response ended before `closed` resolves, so whoever awaits `closed`
 * finds the end already on record.
 */
export function createResponseStream(
	request: IncomingMessage,
	response: ServerResponse,
	onClose: (end: OpenResponseEnd, failed: boolean) => void,
): ServedStream {
	let state: "open" | "ended" | "cut" = "open";
	let failed = false;
	const closed = createDeferred<OpenResponseEnd>();
	response.once("close", () => {
		// Not ended and not cut: the client let go of it.
		const end = state === "open" ? "cancelled" : state;
		onClose(end, failed);
		closed.resolve(end);
	});
	/** The server's own headers (a stream server's CORS, `connection`), before the writer's. */
	const own = Object.entries(response.getHeaders());
	/** Back to those: what the writer's head set is gone, what it replaced is back. */
	const restore = () => {
		for (const name of response.getHeaderNames()) response.removeHeader(name);
		for (const [name, value] of own)
			response.setHeader(name, value as OutgoingHttpHeader);
	};
	/**
	 * Whether a write can reach the client. Node drops a write — callback and
	 * all — into a socket destroyed or closed for writing, which is what the
	 * client letting go leaves, well before the response reports its close.
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
				// Kept off the wire until the first write or flush, so a writer that
				// fails before then can still be answered with its 500.
				restore();
				response.statusCode = status;
				for (const [name, value] of Object.entries(headers)) {
					// The server's to say: a stream server's is one response each.
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
