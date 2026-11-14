import type { ContextValues } from "@connectrpc/connect";
import type {
	UniversalServerRequest,
	UniversalServerResponse,
} from "@connectrpc/connect/protocol";

import type {
	HttpRequestView,
	ResponseStream,
} from "../../../entities/plugin/index.js";
import { concatBytes } from "../../../shared/lib/bytes/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";

/** A Playwright request, as the request Connect's handlers expect. */
export function toUniversalRequest(
	view: HttpRequestView,
	contextValues: ContextValues,
	signal: AbortSignal = new AbortController().signal,
): UniversalServerRequest {
	const body = view.body();
	return {
		httpVersion: "1.1",
		url: view.url.href,
		method: view.method,
		header: new Headers(view.headers),
		body: (async function* () {
			if (body.byteLength > 0) yield body;
		})(),
		signal,
		contextValues,
	};
}

/**
 * A response's headers as a plain record. `set-cookie` keeps every value,
 * one per line, which is how a route and a Node response take several.
 */
function headersOf(response: UniversalServerResponse): Record<string, string> {
	const headers: Record<string, string> = {};
	response.header?.forEach((value, name) => {
		headers[name] = value;
	});
	const cookies = response.header?.getSetCookie() ?? [];
	if (cookies.length > 1) headers["set-cookie"] = cookies.join("\n");
	return headers;
}

/**
 * Connect and gRPC-web carry their trailers in the headers or the body; only
 * native gRPC needs HTTP trailers, which neither a route nor the stream
 * server sends — and which a browser could not have asked for anyway.
 */
function refuseTrailers(response: UniversalServerResponse): void {
	let trailers = 0;
	response.trailer?.forEach(() => {
		trailers += 1;
	});
	if (trailers > 0)
		throw new WirestageError(
			"UNSUPPORTED",
			"this response needs HTTP trailers (native gRPC), which a browser route cannot send; use serve() for gRPC clients",
		);
}

export interface CollectedResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
}

/** Read a handler's whole response, for `route.fulfill`. */
export async function collectResponse(
	response: UniversalServerResponse,
): Promise<CollectedResponse> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of response.body ?? []) chunks.push(chunk);
	refuseTrailers(response);
	return {
		status: response.status,
		headers: headersOf(response),
		body: concatBytes(chunks),
	};
}

/**
 * Write a handler's response to an open stream as the handler produces it:
 * the head with the first chunk, as a real Connect server sends it, and each
 * message as soon as the implementation yields it.
 */
export async function pipeResponse(
	response: UniversalServerResponse,
	stream: ResponseStream,
): Promise<void> {
	stream.head(response.status, headersOf(response));
	// A streaming handler always answers with a body, error trailers included.
	for await (const chunk of response.body as AsyncIterable<Uint8Array>)
		await stream.write(chunk);
	refuseTrailers(response);
	await stream.end();
}
