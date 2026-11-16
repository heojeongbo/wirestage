/**
 * Every failure the library raises on purpose carries a code, so a test can
 * assert on the kind of failure instead of on message text that will change.
 */
export type WirestageErrorCode =
	/** A caller passed something the API cannot work with. */
	| "INVALID_ARGUMENT"
	/** The call is valid but not now: before attach, after dispose, twice. */
	| "INVALID_STATE"
	/** A wait ran out of time. The message lists what did arrive. */
	| "TIMEOUT"
	/** The environment cannot do this, e.g. a live stream on an https page without TLS. */
	| "UNSUPPORTED"
	/** The stream, connection or stage this call needs has already closed. */
	| "CLOSED";

export interface WirestageErrorOptions {
	readonly cause?: unknown;
	readonly details?: Readonly<Record<string, unknown>>;
}

export class WirestageError extends Error {
	override readonly name = "WirestageError";
	readonly code: WirestageErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(
		code: WirestageErrorCode,
		message: string,
		options: WirestageErrorOptions = {},
	) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.code = code;
		this.details = options.details ?? {};
	}
}

/** True when `value` is a WirestageError, optionally of one code. */
export function isWirestageError(
	value: unknown,
	code?: WirestageErrorCode,
): value is WirestageError {
	return (
		value instanceof WirestageError &&
		(code === undefined || value.code === code)
	);
}

/** What went wrong, in words: an error's message, or anything else thrown as a string. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
