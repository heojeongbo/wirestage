import type { Duplex } from "node:stream";

import { createDeferred } from "../../lib/async/index.js";
import { concatBytes, fitUtf8 } from "../../lib/bytes/index.js";
import type { Clock } from "../../lib/clock/index.js";
import { messageOf, WirestageError } from "../../lib/errors/index.js";
import {
	createFrameReader,
	encodeFrame,
	OPCODE,
	ProtocolError,
	type WireFrame,
} from "./websocket-frame.js";

/** How a served WebSocket ended. */
export interface ServedWebSocketEnd {
	/**
	 * The code of the close frame that started the closing: 1005 when it
	 * carried none, 1006 when the connection ended without one.
	 */
	readonly code: number;
	readonly reason: string;
	/**
	 * Whose close frame went first — or, with none, whose end dropped the
	 * connection. A client that broke the protocol is closed by the server.
	 */
	readonly by: "client" | "server";
}

/** One accepted WebSocket, the server's end of it. */
export interface ServedWebSocket {
	/** The subprotocol agreed on; empty for none. */
	readonly protocol: string;
	/** True until either end starts to close it. */
	readonly open: boolean;
	/**
	 * Send one message: text in a text frame, bytes in a binary one. Dropped
	 * once the connection is not open.
	 */
	send(data: string | Uint8Array): void;
	/**
	 * Start the closing handshake; resolves once the connection is over. A
	 * client that does not answer within the close timeout is dropped. A
	 * reason without a code goes out with 1000, cut to the 123 bytes a close
	 * frame has room for. Throws `INVALID_ARGUMENT` for a code a server may
	 * not send.
	 */
	close(code?: number, reason?: string): Promise<ServedWebSocketEnd>;
	/** Drop the connection without a close frame. */
	cut(): void;
	readonly closed: Promise<ServedWebSocketEnd>;
}

export interface WebSocketTimings {
	readonly clock: Clock;
	/** The largest message, in bytes, a client may send. */
	readonly maxPayload: number;
	/** How long a close waits for the client's close frame. */
	readonly closeTimeoutMs: number;
}

/** May a close frame carry `code`? RFC 6455 §7.4, and the IANA registry. */
export const isCloseCode = (code: number): boolean =>
	(code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
	(code >= 3000 && code <= 4999);

const encoder = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });
const ignore = (): void => undefined;

/** UTF-8 that must be valid (§8.1): a client that sends anything else fails with 1007. */
function decodeText(bytes: Uint8Array, what: string): string {
	try {
		return strict.decode(bytes);
	} catch {
		throw new ProtocolError(1007, `${what} is not valid UTF-8`);
	}
}

/** A close frame's payload: the code, if there is one, then the reason. */
function closePayload(code: number | undefined, reason: string): Uint8Array {
	if (code === undefined) return new Uint8Array(0);
	const text = encoder.encode(reason);
	const payload = new Uint8Array(2 + text.length);
	payload[0] = code >> 8;
	payload[1] = code & 0xff;
	payload.set(text, 2);
	return payload;
}

/** What a client's close frame says (§5.5.1). */
function readClose(payload: Uint8Array): {
	readonly code: number | undefined;
	readonly reason: string;
} {
	if (payload.length === 0) return { code: undefined, reason: "" };
	if (payload.length === 1)
		throw new ProtocolError(1002, "a close frame has a 1-byte payload");
	const code = ((payload[0] as number) << 8) | (payload[1] as number);
	if (!isCloseCode(code))
		throw new ProtocolError(1002, `a close frame has the code ${code}`);
	return { code, reason: decodeText(payload.subarray(2), "a close reason") };
}

/**
 * The server's end of an accepted WebSocket over `socket`. `onMessage`
 * hears each message the client sends — text as a string, binary as bytes —
 * and must not throw: one that does fails the connection with 1011.
 */
export function createServedWebSocket(
	socket: Duplex,
	protocol: string,
	onMessage: (data: string | Uint8Array) => void,
	timings: WebSocketTimings,
): ServedWebSocket {
	const read = createFrameReader(timings.maxPayload);
	const ended = createDeferred<ServedWebSocketEnd>();
	const guard = new AbortController();
	let open = true;
	let reading = true;
	/** What `closed` will say, from the moment it is known. */
	let end: ServedWebSocketEnd | undefined;
	/** A message still arriving in fragments. */
	let message:
		| { readonly text: boolean; readonly parts: Uint8Array[]; size: number }
		| undefined;

	const write = (opcode: number, payload: Uint8Array): void => {
		socket.write(encodeFrame(opcode, payload));
	};

	/**
	 * No longer open: `closed` will say `how`. A client still holding the
	 * connection when the close timeout runs out is dropped.
	 */
	const beginClosing = (how: ServedWebSocketEnd): void => {
		open = false;
		end = how;
		timings.clock
			.sleep(timings.closeTimeoutMs, guard.signal)
			.then(() => socket.destroy(), ignore);
	};

	/**
	 * The last this end reads: a close frame goes out unless one already
	 * did, and the server ends the TCP connection (§7.1.1).
	 */
	const finish = (how: ServedWebSocketEnd, payload: Uint8Array): void => {
		reading = false;
		socket.off("data", onData);
		if (open) {
			beginClosing(how);
			write(OPCODE.close, payload);
		}
		socket.end();
	};

	const onFrame = (frame: WireFrame): void => {
		switch (frame.opcode) {
			case OPCODE.ping:
				write(OPCODE.pong, frame.payload);
				return;
			case OPCODE.pong:
				return;
			case OPCODE.close: {
				const { code, reason } = readClose(frame.payload);
				// The answer echoes the code alone.
				finish(
					{ code: code ?? 1005, reason, by: "client" },
					frame.payload.subarray(0, 2),
				);
				return;
			}
			case OPCODE.continuation:
				if (message === undefined)
					throw new ProtocolError(
						1002,
						"a continuation frame had no message to continue",
					);
				message.parts.push(frame.payload);
				message.size += frame.payload.length;
				if (message.size > timings.maxPayload)
					throw new ProtocolError(
						1009,
						`a message is over the ${timings.maxPayload}-byte limit`,
					);
				break;
			default:
				if (message !== undefined)
					throw new ProtocolError(
						1002,
						"a message began before the last one ended",
					);
				message = {
					text: frame.opcode === OPCODE.text,
					parts: [frame.payload],
					size: frame.payload.length,
				};
		}
		if (!frame.fin) return;
		const { text, parts } = message as NonNullable<typeof message>;
		message = undefined;
		const bytes = concatBytes(parts);
		onMessage(text ? decodeText(bytes, "a text message") : bytes);
	};

	/** Fail the connection (§7.1.7): say why in a close frame, then end it. */
	const fail = (error: unknown): void => {
		const { code } = error instanceof ProtocolError ? error : { code: 1011 };
		const reason = fitUtf8(messageOf(error), 123);
		finish({ code, reason, by: "server" }, closePayload(code, reason));
	};

	function onData(chunk: Uint8Array): void {
		try {
			for (const frame of read(chunk)) {
				onFrame(frame);
				// Nothing after a close frame is read (§5.5.1).
				if (!reading) return;
			}
		} catch (error) {
			fail(error);
		}
	}

	socket.on("data", onData);
	// A reset or a write after the client went: `close` follows.
	socket.on("error", ignore);
	// A client that half-closes without a close frame has gone.
	socket.on("end", () => socket.end());
	socket.once("close", () => {
		open = false;
		guard.abort();
		ended.resolve(end ?? { code: 1006, reason: "", by: "client" });
	});

	return {
		protocol,
		get open() {
			return open;
		},
		send(data) {
			if (!open) return;
			if (typeof data === "string") write(OPCODE.text, encoder.encode(data));
			else write(OPCODE.binary, data);
		},
		close(code, reason = "") {
			if (code !== undefined && !isCloseCode(code))
				throw new WirestageError(
					"INVALID_ARGUMENT",
					`a WebSocket server cannot close with ${code}: it sends 1000-1003, 1007-1014 or 3000-4999`,
				);
			if (open) {
				const fitted = fitUtf8(reason, 123);
				const sent = code ?? (fitted === "" ? undefined : 1000);
				beginClosing({ code: sent ?? 1005, reason: fitted, by: "server" });
				write(OPCODE.close, closePayload(sent, fitted));
			}
			return ended.promise;
		},
		cut() {
			open = false;
			end ??= { code: 1006, reason: "", by: "server" };
			socket.destroy();
		},
		closed: ended.promise,
	};
}
