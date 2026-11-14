import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";

import { type Listening, type ListenOptions, listen } from "./listen.js";
import {
	createResponseStream,
	type OpenResponseEnd,
	type ServedStream,
} from "./response-stream.js";

/** A request a served fake received, read in full before it is handed on. */
export interface ServedRequest {
	readonly method: string;
	/** Absolute: the server's origin, then the path and query the client sent. */
	readonly url: URL;
	/** Lower-cased names; a repeated header's values joined with `, `. */
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
}

/** The answer to a {@link ServedRequest}: one of the three, once. */
export interface ServedResponse {
	/**
	 * Send a complete response. A header may carry several values separated
	 * by a newline (`set-cookie`). Resolves once it is written.
	 */
	send(
		status: number,
		headers: Readonly<Record<string, string>>,
		body: Uint8Array | string,
	): Promise<void>;
	/**
	 * Hold the response open, for a body written as it comes. `onClose`
	 * hears how it ended, `failed` when it was failed, before the stream's
	 * `closed` resolves.
	 */
	open(onClose: (end: OpenResponseEnd, failed: boolean) => void): ServedStream;
	/** Drop the connection: no status, no body — a network failure. */
	reset(): void;
}

export type RequestHandler = (
	request: ServedRequest,
	response: ServedResponse,
) => void | Promise<void>;

const headersOf = (message: IncomingMessage): Record<string, string> =>
	Object.fromEntries(
		Object.entries(message.headersDistinct as Record<string, string[]>).map(
			([name, values]) => [name, values.join(", ")],
		),
	);

const readBody = (message: IncomingMessage): Promise<Uint8Array> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		message.on("data", (chunk: Buffer) => chunks.push(chunk));
		message.once("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
		message.once("error", reject);
	});

function responderOf(
	message: IncomingMessage,
	response: ServerResponse,
): ServedResponse {
	return {
		send(status, headers, body) {
			for (const [name, value] of Object.entries(headers))
				response.setHeader(
					name,
					value.includes("\n") ? value.split("\n") : value,
				);
			// Said, not left to Node: Node drops a HEAD response's body and its
			// length with it, and a client sizes what it would download by it.
			// A 204 or 304 carries none.
			if (
				status !== 204 &&
				status !== 304 &&
				!response.hasHeader("content-length")
			)
				response.setHeader("content-length", Buffer.byteLength(body));
			response.statusCode = status;
			return new Promise<void>((resolve) => {
				// `close` too: a client that went away never sees `finish`.
				response.once("close", () => resolve());
				response.end(body);
			});
		},
		open: (onClose) => createResponseStream(message, response, onClose),
		reset() {
			response.destroy();
		},
	};
}

/**
 * An HTTP/1.1 server for clients outside the browser, handing each request,
 * body read, to `handle`. The handler is the caller's to make safe; one that
 * throws anyway gets a 500 rather than a client left waiting, and closing the
 * server drops open connections at once (`listen`).
 */
export async function serveHttp(
	options: Omit<ListenOptions, "protocol">,
	handle: RequestHandler,
): Promise<Listening> {
	const server = createServer((message, response) => {
		const responder = responderOf(message, response);
		readBody(message)
			.then((body) =>
				handle(
					{
						// Always set on a request an http.Server received.
						method: message.method as string,
						url: new URL(message.url as string, listening.url),
						headers: headersOf(message),
						body,
					},
					responder,
				),
			)
			.catch((error: unknown) => {
				if (response.headersSent) response.destroy();
				else
					void responder.send(
						500,
						{ "content-type": "text/plain; charset=utf-8" },
						`wirestage: ${options.name} failed: ${error instanceof Error ? error.message : String(error)}`,
					);
			});
	});
	const listening = await listen(server, { ...options, protocol: "http" });
	return listening;
}
