import { gunzipSync } from "node:zlib";

import {
	type DescMessage,
	fromBinary,
	fromJsonString,
	type JsonReadOptions,
	type MessageShape,
} from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
	codeFromString,
	codeFromHttpStatus as connectCodeFromHttpStatus,
} from "@connectrpc/connect/protocol-connect";
import { codeFromHttpStatus as grpcCodeFromHttpStatus } from "@connectrpc/connect/protocol-grpc";

import type {
	HttpRequestView,
	PassthroughResponse,
} from "../../../entities/plugin/index.js";
import {
	concatBytes,
	fromBase64,
	toBase64,
	utf8,
} from "../../../shared/lib/bytes/index.js";
import {
	decodeEnvelopes,
	EnvelopeFlag,
	encodeEnvelope,
	parseTrailerBlock,
} from "../../../shared/lib/envelope/index.js";
import type { RpcProtocol } from "../model/types.js";

/** How one request (and so its response) is encoded on the wire. */
export interface WireFormat {
	readonly protocol: RpcProtocol;
	/** Protobuf binary, or JSON. */
	readonly binary: boolean;
	/** gRPC-web-text: the whole body is base64. */
	readonly base64: boolean;
	/** Length-prefixed envelopes (every protocol's streaming form). */
	readonly enveloped: boolean;
}

/**
 * Read the format off a request, the way a Connect server negotiates it.
 * Undefined means "not an RPC this plugin understands" — a rule then falls
 * through instead of mangling, say, a REST call that shares the path prefix.
 */
export function detectFormat(
	request: Pick<HttpRequestView, "method" | "url" | "headers">,
): WireFormat | undefined {
	const contentType = (request.headers["content-type"] ?? "")
		.split(";")[0]
		?.trim()
		.toLowerCase();
	if (contentType?.startsWith("application/grpc-web-text"))
		return {
			protocol: "grpc-web",
			binary: !contentType.endsWith("+json"),
			base64: true,
			enveloped: true,
		};
	if (contentType?.startsWith("application/grpc-web"))
		return {
			protocol: "grpc-web",
			binary: !contentType.endsWith("+json"),
			base64: false,
			enveloped: true,
		};
	if (contentType?.startsWith("application/grpc"))
		return {
			protocol: "grpc",
			binary: !contentType.endsWith("+json"),
			base64: false,
			enveloped: true,
		};
	if (contentType?.startsWith("application/connect+"))
		return {
			protocol: "connect",
			binary: contentType === "application/connect+proto",
			base64: false,
			enveloped: true,
		};
	if (contentType === "application/proto" || contentType === "application/json")
		return {
			protocol: "connect",
			binary: contentType === "application/proto",
			base64: false,
			enveloped: false,
		};
	// Connect's GET form for side-effect-free methods carries the message in
	// the query string and sends no content type at all.
	if (
		request.method === "GET" &&
		request.url.searchParams.get("connect") === "v1"
	)
		return {
			protocol: "connect",
			binary: request.url.searchParams.get("encoding") !== "json",
			base64: false,
			enveloped: false,
		};
	return undefined;
}

export interface RpcStatus {
	/** 0 is OK; otherwise the gRPC / Connect code number. */
	readonly code: number;
	readonly message: string;
}

export interface DecodedBody {
	/** Message payloads, decompressed when the encoding is gzip. */
	readonly messages: readonly Uint8Array[];
	readonly status: RpcStatus | undefined;
}

const OK: RpcStatus = { code: 0, message: "" };

/** The request's messages, from its body or (Connect GET) its query. */
export function decodeRequestBody(
	format: WireFormat,
	request: Pick<HttpRequestView, "url" | "headers" | "body">,
): Uint8Array[] {
	if (!format.enveloped) {
		const query = request.url.searchParams;
		if (query.get("connect") === "v1") {
			const message = query.get("message") ?? "";
			return [
				query.get("base64") === "1"
					? fromBase64(message.replaceAll("-", "+").replaceAll("_", "/"))
					: new TextEncoder().encode(message),
			];
		}
		return [request.body()];
	}
	const body = format.base64
		? fromBase64Stream(request.body())
		: request.body();
	return dataEnvelopes(
		body,
		request.headers[
			format.protocol === "connect"
				? "connect-content-encoding"
				: "grpc-encoding"
		],
	);
}

/**
 * The request carrying `message` in place of its own, in the request's
 * format: the body of a POST, the query of a Connect GET. Not for
 * gRPC-web-text, which no rule of this plugin takes.
 *
 * One uncompressed message, however the original was sent: a server reads
 * each envelope's flag, and an uncompressed one is valid under any
 * `grpc-encoding`, so the header can stay as the page set it.
 */
export function encodeRequest(
	format: WireFormat,
	request: Pick<HttpRequestView, "method" | "url">,
	message: Uint8Array,
): { readonly body: Uint8Array } | { readonly url: string } {
	if (format.enveloped) return { body: encodeEnvelope(0, message) };
	if (request.method !== "GET") return { body: message };
	const url = new URL(request.url);
	// Binary always rides as base64url; JSON as text unless the caller chose
	// base64 too. Either way the encoding the caller picked is kept.
	url.searchParams.set(
		"message",
		url.searchParams.get("base64") === "1"
			? toBase64(message)
					.replaceAll("+", "-")
					.replaceAll("/", "_")
					.replace(/=+$/, "")
			: utf8(message),
	);
	return { url: url.href };
}

/** Messages and status from a response the real backend sent. */
export function decodeResponseBody(
	format: WireFormat,
	response: PassthroughResponse,
): DecodedBody {
	const headers = response.headers;
	const raw = response.body ?? new Uint8Array(0);
	if (!format.enveloped) {
		if (response.status !== 200)
			return { messages: [], status: connectError(raw, response.status) };
		// A 200 that is not a message is something on the way — a proxy's
		// sign-in page, say — and a Connect client reports it as an error.
		const contentType = headers["content-type"] ?? "";
		if (!/^application\/(proto|json)\b/i.test(contentType))
			return {
				messages: [],
				status: {
					code: Code.Unknown,
					message: `unexpected content type "${contentType}"`,
				},
			};
		return { messages: [raw], status: OK };
	}
	const body = format.base64 ? fromBase64Stream(raw) : raw;
	const { envelopes } = decodeEnvelopes(body);
	const encoding =
		headers[
			format.protocol === "connect"
				? "connect-content-encoding"
				: "grpc-encoding"
		];
	const messages: Uint8Array[] = [];
	let status: RpcStatus | undefined;
	for (const envelope of envelopes) {
		if (
			format.protocol === "connect" &&
			envelope.flags & EnvelopeFlag.endStream
		)
			status = endStream(inflate(envelope.flags, envelope.data, encoding));
		else if (envelope.flags & EnvelopeFlag.trailer)
			status = grpcStatus(parseTrailerBlock(envelope.data));
		else messages.push(inflate(envelope.flags, envelope.data, encoding));
	}
	// A trailers-only response carries the status in the headers instead.
	if (status === undefined && headers["grpc-status"] !== undefined)
		status = grpcStatus(headers);
	// No status anywhere and not a 200: a gateway answered, not the server.
	// The client maps the HTTP status to a code, and so does the record.
	if (status === undefined && response.status !== 200)
		status = {
			code:
				format.protocol === "connect"
					? connectCodeFromHttpStatus(response.status)
					: grpcCodeFromHttpStatus(response.status),
			message: `HTTP ${response.status}`,
		};
	return { messages, status };
}

/** Parse a message payload with the request's format. */
export function parseMessage<Desc extends DescMessage>(
	schema: Desc,
	bytes: Uint8Array,
	binary: boolean,
	jsonOptions?: Partial<JsonReadOptions>,
): MessageShape<Desc> {
	return binary
		? fromBinary(schema, bytes)
		: fromJsonString(schema, utf8(bytes), {
				ignoreUnknownFields: true,
				...jsonOptions,
			});
}

/**
 * Connect's `{ "code": "not_found", "message": "..." }` error body. A body
 * that is not one came from something on the way, and the HTTP status is all
 * there is to go by — which is how a Connect client reads it too.
 */
export function connectError(body: Uint8Array, httpStatus: number): RpcStatus {
	try {
		const status = errorStatus(JSON.parse(utf8(body)));
		if (status !== undefined) return status;
	} catch {
		// Not JSON at all.
	}
	return {
		code: connectCodeFromHttpStatus(httpStatus),
		message: `HTTP ${httpStatus}`,
	};
}

/** The status in a Connect error object; undefined when it names no code. */
function errorStatus(value: unknown): RpcStatus | undefined {
	const error = (typeof value === "object" && value !== null ? value : {}) as {
		readonly code?: unknown;
		readonly message?: unknown;
	};
	const code =
		typeof error.code === "string" ? codeFromString(error.code) : undefined;
	if (code === undefined) return undefined;
	return {
		code,
		message: typeof error.message === "string" ? error.message : "",
	};
}

function grpcStatus(fields: Readonly<Record<string, string>>): RpcStatus {
	const code = Number(fields["grpc-status"]);
	return {
		code: Number.isInteger(code) ? code : Code.Unknown,
		message: safeDecodeURIComponent(fields["grpc-message"] ?? ""),
	};
}

/** Connect's end-of-stream JSON: `{}` for OK, `{ "error": {...} }` otherwise. */
function endStream(data: Uint8Array): RpcStatus {
	try {
		const parsed = JSON.parse(utf8(data)) as { readonly error?: unknown };
		if (parsed.error === undefined) return OK;
		return (
			errorStatus(parsed.error) ?? {
				code: Code.Unknown,
				message: "end-of-stream error with no code",
			}
		);
	} catch {
		return { code: Code.Unknown, message: "malformed end-of-stream message" };
	}
}

/**
 * gRPC-web-text: base64, but not one base64 string. A server encodes each
 * chunk it flushes on its own, padding included, so a stream is several
 * encodings end to end, and decoding it as one stops at the first padding.
 */
function fromBase64Stream(body: Uint8Array): Uint8Array {
	const parts = utf8(body).match(/[^=]+=*/g) ?? [];
	return concatBytes(parts.map((part) => fromBase64(part)));
}

function dataEnvelopes(
	body: Uint8Array,
	encoding: string | undefined,
): Uint8Array[] {
	return decodeEnvelopes(body)
		.envelopes.filter(
			(e) =>
				!(e.flags & EnvelopeFlag.trailer) &&
				!(e.flags & EnvelopeFlag.endStream),
		)
		.map((e) => inflate(e.flags, e.data, encoding));
}

/** Decompress a compressed envelope when the encoding is gzip; otherwise as is. */
function inflate(
	flags: number,
	data: Uint8Array,
	encoding: string | undefined,
): Uint8Array {
	if (!(flags & EnvelopeFlag.compressed) || encoding !== "gzip") return data;
	return new Uint8Array(gunzipSync(data));
}

/** gRPC percent-encodes `grpc-message`; a malformed escape must not throw. */
function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
