import { concatBytes, utf8 } from "../bytes/index.js";

/**
 * The length-prefixed message framing that gRPC, gRPC-web and Connect
 * streaming share: one flag byte, a 4-byte big-endian length, the payload.
 *
 * Every hand-written gRPC-web stub ends up re-deriving this; getting the
 * trailer bit or the length endianness wrong produces a response the client
 * rejects with an error that names neither.
 */
export const EnvelopeFlag = {
	/** gRPC / gRPC-web / Connect: the payload is compressed. */
	compressed: 0b0000_0001,
	/** Connect streaming: the payload is the end-of-stream JSON. */
	endStream: 0b0000_0010,
	/** gRPC-web: the payload is the trailer block, not a message. */
	trailer: 0b1000_0000,
} as const;

export interface Envelope {
	readonly flags: number;
	readonly data: Uint8Array;
}

const HEADER = 5;

export function encodeEnvelope(flags: number, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(HEADER + data.byteLength);
	out[0] = flags;
	new DataView(out.buffer).setUint32(1, data.byteLength, false);
	out.set(data, HEADER);
	return out;
}

export function encodeEnvelopes(envelopes: readonly Envelope[]): Uint8Array {
	return concatBytes(envelopes.map((e) => encodeEnvelope(e.flags, e.data)));
}

export interface EnvelopeReader {
	/** Feed bytes; returns every envelope they complete, in order. */
	push(chunk: Uint8Array): Envelope[];
	/** Bytes held back because they do not complete an envelope yet. */
	readonly buffered: number;
}

/**
 * Incremental reader for a byte stream that may split an envelope anywhere,
 * including inside the 5-byte header — which is exactly how HTTP chunking
 * delivers a long server stream.
 *
 * Chunks that do not complete an envelope are kept as they came and joined
 * only once it is complete, so a large message arriving in small chunks is
 * copied once, not once per chunk.
 */
export function createEnvelopeReader(): EnvelopeReader {
	let pending: Uint8Array[] = [];
	let buffered = 0;

	/** Whether the pending chunks hold at least one whole envelope. */
	const complete = (): boolean => {
		if (buffered < HEADER) return false;
		// The header may itself straddle chunks: gather just those five bytes.
		const header = new Uint8Array(HEADER);
		let filled = 0;
		for (const chunk of pending) {
			const part = chunk.subarray(0, HEADER - filled);
			header.set(part, filled);
			filled += part.byteLength;
			if (filled === HEADER) break;
		}
		const length = new DataView(header.buffer).getUint32(1, false);
		return buffered >= HEADER + length;
	};

	return {
		push(chunk) {
			pending.push(chunk);
			buffered += chunk.byteLength;
			if (!complete()) return [];
			const bytes = concatBytes(pending);
			const out: Envelope[] = [];
			let offset = 0;
			while (bytes.byteLength - offset >= HEADER) {
				const view = new DataView(
					bytes.buffer,
					bytes.byteOffset + offset,
					HEADER,
				);
				const length = view.getUint32(1, false);
				if (bytes.byteLength - offset - HEADER < length) break;
				out.push({
					flags: view.getUint8(0),
					data: bytes.subarray(offset + HEADER, offset + HEADER + length),
				});
				offset += HEADER + length;
			}
			const rest = bytes.subarray(offset);
			pending = rest.byteLength === 0 ? [] : [rest];
			buffered = rest.byteLength;
			return out;
		},
		get buffered() {
			return buffered;
		},
	};
}

/** Decode a complete body. `rest` holds a truncated tail, if any. */
export function decodeEnvelopes(bytes: Uint8Array): {
	readonly envelopes: Envelope[];
	readonly rest: number;
} {
	const reader = createEnvelopeReader();
	const envelopes = reader.push(bytes);
	return { envelopes, rest: reader.buffered };
}

/**
 * Parse a gRPC-web trailer block (`name: value\r\n` lines). Names are
 * lower-cased; HTTP/1.1 header names are case-insensitive and gRPC-web
 * servers disagree on the spelling.
 */
export function parseTrailerBlock(data: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of utf8(data).split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		out[line.slice(0, colon).trim().toLowerCase()] = line
			.slice(colon + 1)
			.trim();
	}
	return out;
}
