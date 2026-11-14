import { create, toBinary } from "@bufbuild/protobuf";
import { bench, describe } from "vitest";

import { EchoRequestSchema } from "../src/__fixtures__/gen/wirestage/test/v1/echo_pb.js";
import { createPayload } from "../src/entities/frame/index.js";
import {
	decodeResponseBody,
	detectFormat,
} from "../src/features/connect/lib/protocol.js";
import {
	compileUrlMatcher,
	createEnvelopeReader,
	decodeEnvelopes,
	EnvelopeFlag,
	encodeEnvelope,
	encodeEnvelopes,
} from "../src/index.js";
import { encodeSseEvent } from "../src/sse.js";

const small = new Uint8Array(64).fill(7);
const large = new Uint8Array(4096).fill(7);
const stream = encodeEnvelopes(
	Array.from({ length: 100 }, () => ({ flags: 0, data: small })),
);
const trailer = encodeEnvelope(
	EnvelopeFlag.trailer,
	new TextEncoder().encode("grpc-status: 0\r\n"),
);
const grpcWebBody = new Uint8Array([...stream, ...trailer]);

describe("envelopes", () => {
	bench("encode 64 B", () => {
		encodeEnvelope(0, small);
	});
	bench("encode 4 KiB", () => {
		encodeEnvelope(0, large);
	});
	bench("decode a 100-message body", () => {
		decodeEnvelopes(stream);
	});
	bench("read a 100-message body in 7-byte chunks", () => {
		const reader = createEnvelopeReader();
		for (let i = 0; i < stream.length; i += 7)
			reader.push(stream.subarray(i, i + 7));
	});
});

describe("connect decoding", () => {
	const view = {
		method: "POST",
		url: new URL("http://h/pkg.Svc/Watch"),
		headers: { "content-type": "application/grpc-web+proto" },
	};
	const message = toBinary(
		EchoRequestSchema,
		create(EchoRequestSchema, { text: "x".repeat(32) }),
	);
	bench("detect the wire format", () => {
		detectFormat(view);
	});
	bench("decode a 100-message gRPC-web response", () => {
		decodeResponseBody(
			{ protocol: "grpc-web", binary: true, base64: false, enveloped: true },
			{
				status: 200,
				headers: {},
				body: grpcWebBody,
			},
		);
	});
	const decoder = (bytes: Uint8Array) => bytes.length;
	bench("payload decode, cached", () => {
		const payload = createPayload(message);
		payload.decode(decoder);
		payload.decode(decoder);
	});
});

describe("matching and encoding", () => {
	const glob = compileUrlMatcher("**/api/v1/rooms/*/state");
	const path = compileUrlMatcher("/api/**");
	const url = new URL("http://localhost:3000/api/v1/rooms/r1/state");
	bench("glob over a full URL", () => {
		glob(url);
	});
	bench("path pattern", () => {
		path(url);
	});
	bench("encode an SSE event", () => {
		encodeSseEvent({ id: "7", event: "tick", data: { n: 1, text: "hello" } });
	});
});
