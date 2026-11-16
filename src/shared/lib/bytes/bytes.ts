const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Anything the wire can carry: binary views or text (encoded as UTF-8). */
export type BytesLike = Uint8Array | ArrayBuffer | ArrayBufferView | string;

/**
 * View `value` as bytes without copying when it already is binary.
 *
 * A `Buffer` is a `Uint8Array`, so Playwright's buffers pass straight through;
 * copying every recorded payload would double the memory a long test holds.
 */
export function toBytes(value: BytesLike): Uint8Array {
	if (typeof value === "string") return encoder.encode(value);
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** Decode UTF-8. Invalid sequences become U+FFFD instead of throwing. */
export function utf8(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

/**
 * The longest start of `text` whose UTF-8 fits in `bytes` bytes, ending on a
 * whole character: a WebSocket close reason has 123.
 */
export function fitUtf8(text: string, bytes: number): string {
	// `encodeInto` stops before the first character that does not fit whole.
	return text.slice(0, encoder.encodeInto(text, new Uint8Array(bytes)).read);
}

/** Join chunks into one array. One chunk is returned as is. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	let length = 0;
	for (const chunk of chunks) length += chunk.byteLength;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
		"base64",
	);
}

export function fromBase64(text: string): Uint8Array {
	const buffer = Buffer.from(text, "base64");
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** A Node Buffer over the same memory, for APIs that insist on Buffer. */
export function toBuffer(bytes: Uint8Array): Buffer {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
