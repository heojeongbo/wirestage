import { concatBytes } from "../../lib/bytes/index.js";

/**
 * RFC 6455 framing, the server's half. The server sends every message as one
 * frame, unmasked; what it reads must be masked (§5.1), and a message may
 * come in fragments with control frames between them (§5.4).
 */

export const OPCODE = {
	continuation: 0x0,
	text: 0x1,
	binary: 0x2,
	close: 0x8,
	ping: 0x9,
	pong: 0xa,
} as const;

const KNOWN: ReadonlySet<number> = new Set(Object.values(OPCODE));

/** A frame as read, its payload unmasked. */
export interface WireFrame {
	readonly fin: boolean;
	readonly opcode: number;
	readonly payload: Uint8Array;
}

/** A client broke the protocol: the close code to fail the connection with, and why. */
export class ProtocolError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

const viewOf = (bytes: Uint8Array): DataView =>
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** One whole frame, unmasked, as a server sends it. */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
	const length = payload.length;
	let head = 2;
	if (length > 0xffff) head = 10;
	else if (length > 125) head = 4;
	const frame = new Uint8Array(head + length);
	frame[0] = 0x80 | opcode;
	if (head === 2) frame[1] = length;
	else if (head === 4) {
		frame[1] = 126;
		viewOf(frame).setUint16(2, length);
	} else {
		frame[1] = 127;
		viewOf(frame).setBigUint64(2, BigInt(length));
	}
	frame.set(payload, head);
	return frame;
}

/**
 * Reads frames out of bytes that arrive in pieces, refusing a payload over
 * `maxPayload` from its length alone. A frame is joined once, when the last
 * of it is there: a large message in many small chunks would otherwise be
 * copied again with every chunk.
 */
export function createFrameReader(
	maxPayload: number,
): (chunk: Uint8Array) => WireFrame[] {
	let chunks: Uint8Array[] = [];
	let size = 0;
	/** The first `n` bytes buffered, as one array; `n` are there. */
	const peek = (n: number): Uint8Array => {
		if ((chunks[0] as Uint8Array).length < n) chunks = [concatBytes(chunks)];
		return (chunks[0] as Uint8Array).subarray(0, n);
	};
	/** Drop what a `peek(n)` returned: it is all in the first chunk now. */
	const drop = (n: number): void => {
		size -= n;
		const first = chunks[0] as Uint8Array;
		if (first.length > n) chunks[0] = first.subarray(n);
		else chunks.shift();
	};
	/** The frame at the start of the buffer, or undefined until all of it is there. */
	const next = (): WireFrame | undefined => {
		if (size < 2) return undefined;
		const head = peek(2);
		const first = head[0] as number;
		const second = head[1] as number;
		const opcode = first & 0x0f;
		const fin = (first & 0x80) !== 0;
		let length = second & 0x7f;
		if ((first & 0x70) !== 0)
			throw new ProtocolError(1002, "a frame set a reserved bit");
		if (!KNOWN.has(opcode))
			throw new ProtocolError(1002, `a frame has the unknown opcode ${opcode}`);
		if ((second & 0x80) === 0)
			throw new ProtocolError(1002, "a client frame was not masked");
		// A control frame's length fits the first byte, so 126 and 127 are
		// over its limit too.
		if ((opcode & 0x8) !== 0 && (!fin || length > 125))
			throw new ProtocolError(
				1002,
				"a control frame was fragmented or over 125 bytes",
			);
		let offset = 2;
		if (length === 126) {
			if (size < 4) return undefined;
			length = viewOf(peek(4)).getUint16(2);
			offset = 4;
		} else if (length === 127) {
			if (size < 10) return undefined;
			// Past 2^53 the number is no longer exact, but still over the limit.
			length = Number(viewOf(peek(10)).getBigUint64(2));
			offset = 10;
		}
		if (length > maxPayload)
			throw new ProtocolError(
				1009,
				`a frame of ${length} bytes is over the ${maxPayload}-byte limit`,
			);
		const total = offset + 4 + length;
		if (size < total) return undefined;
		const bytes = peek(total);
		const payload = bytes.slice(offset + 4);
		for (let i = 0; i < payload.length; i++)
			payload[i] = (payload[i] as number) ^ (bytes[offset + (i & 3)] as number);
		drop(total);
		return { fin, opcode, payload };
	};
	return (chunk) => {
		chunks.push(chunk);
		size += chunk.length;
		const frames: WireFrame[] = [];
		for (let frame = next(); frame !== undefined; frame = next())
			frames.push(frame);
		return frames;
	};
}
