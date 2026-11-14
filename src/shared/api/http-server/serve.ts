import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";

import { type Listening, type ListenOptions, listen } from "./listen.js";

/** A request a served fake received, read in full before it is handed on. */
export interface ServedRequest {
	readonly method: string;
	/** Absolute: the server's origin, then the path and query the client sent. */
	readonly url: URL;
	/** Lower-cased names; a repeated header's values joined with `, `. */
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
}

/** The answer to a {@link ServedRequest}: one of the two, once. */
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

function responderOf(response: ServerResponse): ServedResponse {
	return {
		send(status, headers, body) {
			for (const [name, value] of Object.entries(headers))
				response.setHeader(
					name,
					value.includes("\n") ? value.split("\n") : value,
				);
			response.statusCode = status;
			return new Promise<void>((resolve) => {
				// `close` too: a client that went away never sees `finish`.
				response.once("close", () => resolve());
				response.end(body);
			});
		},
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
		const responder = responderOf(response);
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
