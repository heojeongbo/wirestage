import type { IncomingMessage, ServerResponse } from "node:http";

import type {
	ResponseStream,
	StreamEnd,
} from "../../../entities/plugin/index.js";
import { createDeferred } from "../../../shared/lib/async/index.js";
import { toBytes } from "../../../shared/lib/bytes/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";

/**
 * A Node response as the stream a rule writes: the adapter between the
 * stream server's sockets and the plugin contract, which knows nothing of
 * Node.
 */
export function createResponseStream(
	request: IncomingMessage,
	response: ServerResponse,
): ResponseStream {
	let state: "open" | "ended" | "cut" = "open";
	const closed = createDeferred<StreamEnd>();
	response.once("close", () =>
		// Not ended and not cut: the page let go of it.
		closed.resolve(state === "open" ? "cancelled" : state),
	);
	const requestHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(request.headers))
		requestHeaders[name] = String(value);
	return {
		requestHeaders,
		head(status, headers = {}) {
			response.writeHead(status, { ...headers });
		},
		flush() {
			response.flushHeaders();
		},
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				if (state !== "open" || response.destroyed) {
					reject(new WirestageError("CLOSED", "the response stream is closed"));
					return;
				}
				response.write(toBytes(chunk), (error) =>
					error ? reject(error) : resolve(),
				);
			});
		},
		async end() {
			if (state !== "open") return;
			state = "ended";
			// A response the page already let go of never calls back from
			// end(): resolve on whichever comes first.
			if (!response.destroyed)
				await new Promise<void>((resolve) => {
					response.once("close", resolve);
					response.end(resolve);
				});
		},
		cut() {
			if (state !== "open") return;
			state = "cut";
			response.destroy();
		},
		closed: closed.promise,
	};
}
