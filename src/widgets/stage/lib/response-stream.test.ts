import { EventEmitter } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { type AddressInfo, connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createResponseStream } from "./response-stream.js";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

/**
 * The stream against a real socket is covered through the router; these are
 * what a socket will not do on demand, or not through a fetch.
 */
describe("response stream", () => {
	it("rejects a write the socket refuses, with the socket's own error", async () => {
		const response = Object.assign(new EventEmitter(), {
			socket: { writable: true },
			getHeaders: () => ({}),
			write: (_chunk: unknown, done: (error?: Error) => void) => {
				done(new Error("write EPIPE"));
				return false;
			},
		}) as unknown as ServerResponse;
		const { stream } = createResponseStream(
			{ headers: { "last-event-id": "7" } } as unknown as IncomingMessage,
			response,
			() => {},
		);
		expect(stream.requestHeaders).toEqual({ "last-event-id": "7" });
		await expect(stream.write("x")).rejects.toThrow("write EPIPE");
	});

	it("refuses a write once the page let go, where Node would never call back", async () => {
		const outcomes: Promise<string>[] = [];
		const server = createServer((request, response) => {
			const { stream } = createResponseStream(request, response, () => {});
			stream.flush();
			// The page lets go (a FIN) and the test writes before Node reports
			// the response closed: a send racing an `EventSource.close()`.
			request.socket.once("end", () =>
				setImmediate(() =>
					outcomes.push(
						Promise.race([
							stream.write("late").then(
								() => "written",
								(error: { code?: string }) => `rejected ${error.code}`,
							),
							new Promise<string>((resolve) =>
								setTimeout(() => resolve("never settled"), 500),
							),
						]),
					),
				),
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		closers.push(() => server.close());
		const page = connect((server.address() as AddressInfo).port, "127.0.0.1");
		closers.push(() => page.destroy());
		await new Promise<void>((resolve) => page.once("connect", resolve));
		page.write("GET /stream HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n");
		await new Promise<void>((resolve) => page.once("data", () => resolve()));
		page.end();
		await expect.poll(() => outcomes.length).toBe(1);
		expect(await outcomes[0]).toBe("rejected CLOSED");
	});
});
