import { createHash } from "node:crypto";
import { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";

import { messageOf } from "../../lib/errors/index.js";
import { headersOf } from "./serve.js";
import {
	createServedWebSocket,
	type ServedWebSocket,
	type WebSocketTimings,
} from "./websocket.js";

/** A WebSocket handshake a served fake received (RFC 6455 §4.2.1). */
export interface ServedUpgrade {
	/** `ws://`, the server's host and port, then the path and query the client asked for. */
	readonly url: URL;
	/** Lower-cased names; a repeated header's values joined with `, `. */
	readonly headers: Readonly<Record<string, string>>;
	/** The subprotocols the client offered, in its order. */
	readonly protocols: readonly string[];
}

/** The answer to a {@link ServedUpgrade}: one of the two, once. */
export interface UpgradeResponse {
	/**
	 * Complete the handshake, agreeing on the first subprotocol the client
	 * offered, if it offered any. `onMessage` hears each message the client
	 * sends — text as a string, binary as bytes — and must not throw: one
	 * that does fails the connection with 1011.
	 */
	accept(onMessage: (data: string | Uint8Array) => void): ServedWebSocket;
	/** Answer with a plain response instead, which fails the handshake. */
	refuse(
		status: number,
		headers: Readonly<Record<string, string>>,
		body: string,
	): void;
}

/**
 * Takes a WebSocket handshake. One that throws before it answers gets a
 * 500, naming the server; one that throws after it accepted has the
 * connection dropped.
 */
export type WebSocketHandler = (
	request: ServedUpgrade,
	response: UpgradeResponse,
) => void | Promise<void>;

export interface UpgradeOptions extends WebSocketTimings {
	/** Names the server in a 500. */
	readonly name: string;
	/** `ws://host:port`. */
	readonly origin: string;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Sixteen bytes in base64 (§4.1). */
const KEY = /^[+/0-9A-Za-z]{22}==$/;
const TEXT = { "content-type": "text/plain; charset=utf-8" };

/** A plain response on a socket the HTTP server has handed over. */
function refuse(
	socket: Duplex,
	status: number,
	headers: Readonly<Record<string, string>>,
	body: string,
): void {
	const lines = [
		`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`,
		...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
		`content-length: ${Buffer.byteLength(body)}`,
		"connection: close",
	];
	// Once it is written, not at once: the client must get the answer.
	socket.once("finish", () => socket.destroy());
	socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

/** Why this is no handshake a WebSocket server can complete; undefined when it is one. */
function problemWith(
	message: IncomingMessage,
): Parameters<UpgradeResponse["refuse"]> | undefined {
	if (message.method !== "GET")
		return [405, { ...TEXT, allow: "GET" }, "a WebSocket handshake is a GET"];
	if (!/(?:^|,)\s*websocket\s*(?:,|$)/i.test(String(message.headers.upgrade)))
		return [400, TEXT, "the Upgrade header does not ask for websocket"];
	// §4.4: a version the server does not speak is answered with the one it does.
	if (message.headers["sec-websocket-version"] !== "13")
		return [
			426,
			{ ...TEXT, "sec-websocket-version": "13" },
			"this server speaks WebSocket version 13",
		];
	if (!KEY.test(String(message.headers["sec-websocket-key"])))
		return [400, TEXT, "the Sec-WebSocket-Key header is missing or malformed"];
	return undefined;
}

/**
 * Complete or refuse the handshake on a socket an HTTP server's `upgrade`
 * event handed over. A request that is not a WebSocket handshake is refused
 * here, before `handle` sees it.
 */
export function handleUpgrade(
	message: IncomingMessage,
	socket: Duplex,
	head: Uint8Array,
	handle: WebSocketHandler,
	options: UpgradeOptions,
): void {
	const problem = problemWith(message);
	if (problem !== undefined) {
		refuse(socket, ...problem);
		return;
	}
	const protocols = String(message.headers["sec-websocket-protocol"] ?? "")
		.split(",")
		.map((offered) => offered.trim())
		.filter((offered) => offered !== "");
	let answered = false;
	const response: UpgradeResponse = {
		accept(onMessage) {
			answered = true;
			const accept = createHash("sha1")
				.update(`${message.headers["sec-websocket-key"]}${GUID}`)
				.digest("base64");
			const protocol = protocols[0] ?? "";
			socket.write(
				[
					"HTTP/1.1 101 Switching Protocols",
					"upgrade: websocket",
					"connection: Upgrade",
					`sec-websocket-accept: ${accept}`,
					...(protocol === "" ? [] : [`sec-websocket-protocol: ${protocol}`]),
					"",
					"",
				].join("\r\n"),
			);
			// What the client sent right after its handshake, which the HTTP
			// parser read past: the first frames.
			socket.unshift(head);
			return createServedWebSocket(socket, protocol, onMessage, options);
		},
		refuse(status, headers, body) {
			answered = true;
			refuse(socket, status, headers, body);
		},
	};
	Promise.resolve()
		.then(() =>
			handle(
				{
					// Always set on a request an http.Server received.
					url: new URL(message.url as string, options.origin),
					headers: headersOf(message),
					protocols,
				},
				response,
			),
		)
		.catch((error: unknown) => {
			if (answered) socket.destroy();
			else
				refuse(
					socket,
					500,
					TEXT,
					`wirestage: ${options.name} failed: ${messageOf(error)}`,
				);
		});
}
