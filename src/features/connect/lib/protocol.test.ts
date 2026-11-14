import { gzipSync } from "node:zlib";

import { create, toBinary, toJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { EchoRequestSchema } from "../../../__fixtures__/gen/wirestage/test/v1/echo_pb.js";
import type { HttpRequestView } from "../../../entities/plugin/index.js";
import {
	EnvelopeFlag,
	encodeEnvelope,
} from "../../../shared/lib/envelope/index.js";
import {
	connectError,
	decodeRequestBody,
	decodeResponseBody,
	detectFormat,
	parseMessage,
	type WireFormat,
} from "./protocol.js";

const encoder = new TextEncoder();
const message = toBinary(
	EchoRequestSchema,
	create(EchoRequestSchema, { text: "hi", count: 2n }),
);

function view(over: {
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: Uint8Array;
}) {
	const body = over.body ?? new Uint8Array(0);
	return {
		method: over.method ?? "POST",
		url: new URL(over.url ?? "http://h/pkg.Svc/M"),
		headers: over.headers ?? {},
		body: () => body,
	} as Pick<HttpRequestView, "method" | "url" | "headers" | "body">;
}

const format = (over: Partial<WireFormat>): WireFormat => ({
	protocol: "grpc-web",
	binary: true,
	base64: false,
	enveloped: true,
	...over,
});

describe("detectFormat", () => {
	it("reads every content type a Connect server negotiates", () => {
		const detect = (contentType: string) =>
			detectFormat(view({ headers: { "content-type": contentType } }));
		expect(detect("application/grpc-web-text+proto")).toEqual(
			format({ base64: true }),
		);
		expect(detect("application/grpc-web-text+json")).toEqual(
			format({ base64: true, binary: false }),
		);
		expect(detect("application/grpc-web+proto")).toEqual(format({}));
		expect(detect("application/grpc-web+json")).toEqual(
			format({ binary: false }),
		);
		expect(detect("application/grpc")).toEqual(format({ protocol: "grpc" }));
		expect(detect("application/grpc+json")).toEqual(
			format({ protocol: "grpc", binary: false }),
		);
		expect(detect("application/connect+proto")).toEqual(
			format({ protocol: "connect" }),
		);
		expect(detect("application/connect+json")).toEqual(
			format({ protocol: "connect", binary: false }),
		);
		expect(detect("application/proto")).toEqual(
			format({ protocol: "connect", enveloped: false }),
		);
		expect(detect("application/json; charset=utf-8")).toEqual(
			format({ protocol: "connect", enveloped: false, binary: false }),
		);
		expect(detect("text/html")).toBeUndefined();
		expect(detectFormat(view({}))).toBeUndefined();
	});

	it("recognizes Connect's GET form by its query", () => {
		expect(
			detectFormat(
				view({ method: "GET", url: "http://h/x?connect=v1&encoding=json" }),
			),
		).toEqual(format({ protocol: "connect", binary: false, enveloped: false }));
		expect(
			detectFormat(
				view({ method: "GET", url: "http://h/x?connect=v1&encoding=proto" }),
			),
		).toEqual(format({ protocol: "connect", enveloped: false }));
		expect(
			detectFormat(view({ method: "GET", url: "http://h/x" })),
		).toBeUndefined();
	});
});

describe("decodeRequestBody", () => {
	it("decodes unary, enveloped, base64 and compressed bodies", () => {
		expect(
			decodeRequestBody(
				format({ protocol: "connect", enveloped: false }),
				view({ body: message }),
			),
		).toEqual([message]);
		const enveloped = encodeEnvelope(0, message);
		expect(decodeRequestBody(format({}), view({ body: enveloped }))).toEqual([
			message,
		]);
		expect(
			decodeRequestBody(
				format({ base64: true }),
				view({
					body: encoder.encode(Buffer.from(enveloped).toString("base64")),
				}),
			),
		).toEqual([message]);
		const zipped = encodeEnvelope(EnvelopeFlag.compressed, gzipSync(message));
		expect(
			decodeRequestBody(
				format({}),
				view({ body: zipped, headers: { "grpc-encoding": "gzip" } }),
			),
		).toEqual([new Uint8Array(message)]);
		expect(
			decodeRequestBody(
				format({ protocol: "connect" }),
				view({ body: zipped, headers: { "connect-content-encoding": "gzip" } }),
			),
		).toEqual([new Uint8Array(message)]);
		// An encoding it cannot inflate is handed on as is.
		expect(
			decodeRequestBody(
				format({}),
				view({ body: zipped, headers: { "grpc-encoding": "br" } }),
			)[0],
		).toEqual(new Uint8Array(gzipSync(message)));
		// Control frames are not messages.
		expect(
			decodeRequestBody(
				format({}),
				view({ body: encodeEnvelope(EnvelopeFlag.trailer, new Uint8Array(1)) }),
			),
		).toEqual([]);
	});

	it("decodes Connect GET messages, base64url or raw", () => {
		const base64url = Buffer.from(message).toString("base64url");
		expect(
			decodeRequestBody(
				format({ protocol: "connect", enveloped: false }),
				view({
					method: "GET",
					url: `http://h/x?connect=v1&encoding=proto&base64=1&message=${base64url}`,
				}),
			),
		).toEqual([new Uint8Array(message)]);
		const json = toJsonString(
			EchoRequestSchema,
			create(EchoRequestSchema, { text: "q" }),
		);
		expect(
			decodeRequestBody(
				format({ protocol: "connect", enveloped: false, binary: false }),
				view({
					method: "GET",
					url: `http://h/x?connect=v1&encoding=json&message=${encodeURIComponent(json)}`,
				}),
			),
		).toEqual([encoder.encode(json)]);
		expect(
			decodeRequestBody(
				format({ protocol: "connect", enveloped: false }),
				view({ method: "GET", url: "http://h/x?connect=v1" }),
			),
		).toEqual([new Uint8Array(0)]);
	});
});

describe("decodeResponseBody", () => {
	const response = (
		status: number,
		headers: Record<string, string>,
		body?: Uint8Array,
	) => ({
		status,
		headers,
		body,
	});

	it("reads unary Connect answers and errors", () => {
		const unary = format({ protocol: "connect", enveloped: false });
		const proto = { "content-type": "application/proto" };
		expect(decodeResponseBody(unary, response(200, proto, message))).toEqual({
			messages: [message],
			status: { code: 0, message: "" },
		});
		expect(
			decodeResponseBody(
				unary,
				response(200, { "content-type": "application/json; charset=utf-8" }),
			).status,
		).toEqual({ code: 0, message: "" });
		expect(
			decodeResponseBody(
				unary,
				response(
					404,
					{},
					encoder.encode('{"code":"not_found","message":"gone"}'),
				),
			),
		).toEqual({ messages: [], status: { code: 5, message: "gone" } });
		expect(
			decodeResponseBody(unary, response(500, {}, encoder.encode("<html>"))),
		).toEqual({
			messages: [],
			status: { code: 2, message: "HTTP 500" },
		});
		expect(decodeResponseBody(unary, response(200, proto))).toEqual({
			messages: [new Uint8Array(0)],
			status: { code: 0, message: "" },
		});
	});

	it("reads what a gateway answered the way the client does", () => {
		const unary = format({ protocol: "connect", enveloped: false });
		// A proxy's sign-in page is a 200, and not an answer.
		expect(
			decodeResponseBody(
				unary,
				response(
					200,
					{ "content-type": "text/html" },
					encoder.encode("<html>"),
				),
			),
		).toEqual({
			messages: [],
			status: { code: 2, message: 'unexpected content type "text/html"' },
		});
		expect(decodeResponseBody(unary, response(200, {})).status).toEqual({
			code: 2,
			message: 'unexpected content type ""',
		});
		// No Connect error body: the HTTP status is all there is to go by.
		expect(
			decodeResponseBody(unary, response(401, {}, encoder.encode("no"))).status,
		).toEqual({ code: 16, message: "HTTP 401" });
		expect(
			decodeResponseBody(unary, response(503, {}, encoder.encode("{}"))).status,
		).toEqual({ code: 14, message: "HTTP 503" });
		// The same for a stream with no status of its own.
		expect(decodeResponseBody(format({}), response(401, {})).status).toEqual({
			code: 16,
			message: "HTTP 401",
		});
		expect(
			decodeResponseBody(format({ protocol: "connect" }), response(503, {}))
				.status,
		).toEqual({ code: 14, message: "HTTP 503" });
	});

	it("reads gRPC-web messages and the trailer, or trailers-only headers", () => {
		const body = new Uint8Array([
			...encodeEnvelope(0, message),
			...encodeEnvelope(
				EnvelopeFlag.trailer,
				encoder.encode("grpc-status: 7\r\ngrpc-message: no%20way\r\n"),
			),
		]);
		expect(decodeResponseBody(format({}), response(200, {}, body))).toEqual({
			messages: [message],
			status: { code: 7, message: "no way" },
		});
		expect(
			decodeResponseBody(
				format({}),
				response(200, { "grpc-status": "16", "grpc-message": "%E0%A4%A" }),
			),
		).toEqual({ messages: [], status: { code: 16, message: "%E0%A4%A" } });
		expect(
			decodeResponseBody(format({}), response(200, { "grpc-status": "x" }))
				.status,
		).toEqual({
			code: 2,
			message: "",
		});
		// A stream cut before its trailer has no status at all.
		expect(
			decodeResponseBody(
				format({}),
				response(200, {}, encodeEnvelope(0, message)),
			).status,
		).toBeUndefined();
		expect(
			decodeResponseBody(
				format({ base64: true }),
				response(
					200,
					{},
					encoder.encode(
						Buffer.from(encodeEnvelope(0, message)).toString("base64"),
					),
				),
			).messages,
		).toEqual([message]);
	});

	it("reads a gRPC-web-text stream whose chunks were encoded one by one", () => {
		// A server encodes each chunk it flushes on its own, padding included:
		// the body is several base64 strings end to end, not one.
		const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
		const first = base64(encodeEnvelope(0, message));
		const second = base64(encodeEnvelope(0, encoder.encode("second!")));
		const trailer = base64(
			encodeEnvelope(
				EnvelopeFlag.trailer,
				encoder.encode("grpc-status: 0\r\n"),
			),
		);
		expect(first).toMatch(/=$/);
		const decoded = decodeResponseBody(
			format({ base64: true }),
			response(200, {}, encoder.encode(first + second + trailer)),
		);
		expect(decoded.messages).toEqual([message, encoder.encode("second!")]);
		expect(decoded.status).toEqual({ code: 0, message: "" });
		// An empty body is no chunks at all.
		expect(
			decodeResponseBody(format({ base64: true }), response(200, {})).messages,
		).toEqual([]);
	});

	it("reads Connect streaming end-of-stream messages and compressed payloads", () => {
		const connect = format({ protocol: "connect" });
		const end = (json: string) =>
			encodeEnvelope(EnvelopeFlag.endStream, encoder.encode(json));
		expect(
			decodeResponseBody(connect, response(200, {}, end("{}"))).status,
		).toEqual({ code: 0, message: "" });
		expect(
			decodeResponseBody(
				connect,
				response(
					200,
					{},
					end('{"error":{"code":"unavailable","message":"down"}}'),
				),
			).status,
		).toEqual({ code: 14, message: "down" });
		expect(
			decodeResponseBody(connect, response(200, {}, end("not json"))).status,
		).toEqual({
			code: 2,
			message: "malformed end-of-stream message",
		});
		expect(
			decodeResponseBody(connect, response(200, {}, end('{"error":"odd"}')))
				.status,
		).toEqual({
			code: 2,
			message: "end-of-stream error with no code",
		});
		expect(
			decodeResponseBody(
				connect,
				response(200, {}, end('{"error":{"code":"aborted"}}')),
			).status,
		).toEqual({ code: 10, message: "" });
		const zipped = new Uint8Array([
			...encodeEnvelope(EnvelopeFlag.compressed, gzipSync(message)),
			...encodeEnvelope(
				EnvelopeFlag.endStream | EnvelopeFlag.compressed,
				gzipSync(encoder.encode("{}")),
			),
		]);
		expect(
			decodeResponseBody(
				connect,
				response(200, { "connect-content-encoding": "gzip" }, zipped),
			),
		).toEqual({
			messages: [new Uint8Array(message)],
			status: { code: 0, message: "" },
		});
	});
});

describe("parseMessage and connectError", () => {
	it("parses binary and JSON, ignoring unknown JSON fields", () => {
		expect(parseMessage(EchoRequestSchema, message, true).text).toBe("hi");
		const json = encoder.encode('{"text":"j","future":1}');
		expect(parseMessage(EchoRequestSchema, json, false).text).toBe("j");
		expect(() =>
			parseMessage(EchoRequestSchema, json, false, {
				ignoreUnknownFields: false,
			}),
		).toThrow();
	});

	it("goes by the HTTP status when the body names no code it knows", () => {
		expect(connectError(encoder.encode('{"code":"weird"}'), 400)).toEqual({
			code: 13,
			message: "HTTP 400",
		});
		expect(connectError(encoder.encode('"just a string"'), 404)).toEqual({
			code: 12,
			message: "HTTP 404",
		});
	});
});
