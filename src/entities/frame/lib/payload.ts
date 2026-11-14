import { toBytes, utf8 } from "../../../shared/lib/bytes/index.js";
import type { Payload, PayloadInput } from "../model/frame.js";

const EMPTY = new Uint8Array(0);

/**
 * A payload that converts lazily and remembers every conversion. Frames are
 * written far more often than read, so nothing is encoded or decoded until a
 * test asks, and asking twice costs once.
 */
export function createPayload(input: PayloadInput | undefined): Payload {
	let bytes: Uint8Array | undefined =
		input instanceof Uint8Array ? input : undefined;
	let text: string | undefined = typeof input === "string" ? input : undefined;
	let decoded: WeakMap<(bytes: Uint8Array) => unknown, unknown> | undefined;

	const getBytes = (): Uint8Array => {
		if (bytes !== undefined) return bytes;
		if (typeof input === "function") bytes = input();
		else if (text !== undefined) bytes = toBytes(text);
		else bytes = EMPTY;
		return bytes;
	};
	const getText = (): string => {
		text ??= utf8(getBytes());
		return text;
	};

	return {
		empty: input === undefined,
		bytes: getBytes,
		text: getText,
		json: <T>() => JSON.parse(getText()) as T,
		decode<T>(decoder: (bytes: Uint8Array) => T): T {
			decoded ??= new WeakMap();
			if (decoded.has(decoder)) return decoded.get(decoder) as T;
			const value = decoder(getBytes());
			decoded.set(decoder, value);
			return value;
		},
	};
}
