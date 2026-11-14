import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { createResponseStream } from "./response-stream.js";

/**
 * The stream against a real socket is covered through the router; this is
 * the one thing a real socket will not do on demand.
 */
describe("response stream", () => {
	it("rejects a write the socket refuses, with the socket's own error", async () => {
		const response = Object.assign(new EventEmitter(), {
			destroyed: false,
			write: (_chunk: unknown, done: (error?: Error) => void) => {
				done(new Error("write EPIPE"));
				return false;
			},
		}) as unknown as ServerResponse;
		const stream = createResponseStream(
			{ headers: { "last-event-id": "7" } } as unknown as IncomingMessage,
			response,
		);
		expect(stream.requestHeaders).toEqual({ "last-event-id": "7" });
		await expect(stream.write("x")).rejects.toThrow("write EPIPE");
	});
});
