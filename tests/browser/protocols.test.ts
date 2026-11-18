/**
 * Every protocol against a real Chromium, through the real Playwright API.
 * The unit suite proves the logic with fakes; this proves the fakes were
 * right about Playwright: route order and fallback, `continue({ url })` onto
 * the stream server, init scripts, bindings and WebSocket routes.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import type { Page } from "@playwright/test";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
	EchoRequestSchema,
	EchoResponseSchema,
	EchoService,
} from "../../src/__fixtures__/gen/wirestage/test/v1/echo_pb.js";
import { connect } from "../../src/connect.js";
import {
	type AnyWirePlugin,
	createStage,
	decodeEnvelopes,
	EnvelopeFlag,
	encodeEnvelope,
	parseTrailerBlock,
} from "../../src/index.js";
import { json, type RestStream, rest, stream } from "../../src/rest.js";
import { sse } from "../../src/sse.js";
import { webrtc } from "../../src/webrtc.js";
import { websocket } from "../../src/websocket.js";
import { close, contextWithPage, ORIGIN, webSocketServer } from "./harness.js";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});
afterAll(close);

async function stageOn<const Plugins extends readonly AnyWirePlugin[]>(
	plugins: Plugins,
	html = "<!doctype html><title>t</title>",
	pageFlushMs = 5,
) {
	const { context, page } = await contextWithPage(html);
	const stage = createStage({ plugins, pageFlushMs });
	await stage.attach(context, { baseURL: ORIGIN });
	disposers.push(async () => {
		await stage.dispose();
		await context.close();
	});
	await page.goto(`${ORIGIN}/`);
	return { stage, context, page };
}

describe("rest in Chromium", () => {
	it("answers fetch from the page and records the exchange", async () => {
		const { stage, page } = await stageOn([rest({ baseURL: "/api" })]);
		await stage.rest.get("/rooms/:id", (request) =>
			json({ id: request.params["id"] }),
		);
		const body = await page.evaluate(async () =>
			(await fetch("/api/rooms/r7")).json(),
		);
		expect(body).toEqual({ id: "r7" });
		const [call] = await stage.rest.calls();
		expect(call).toMatchObject({ method: "GET", status: 200 });
		expect(call?.request.page).toBe("p1");
	});

	it("gives a one-time rule to exactly one of the requests that race for it", async () => {
		const { stage, page } = await stageOn([rest({ baseURL: "/api" })]);
		await stage.rest.get("/turn", json({ from: "always" }));
		const once = await stage.rest.get("/turn", json({ from: "once" }), {
			times: 1,
		});
		const answers = await page.evaluate(() =>
			Promise.all(
				Array.from(
					{ length: 8 },
					async () => (await (await fetch("/api/turn")).json()).from,
				),
			),
		);
		// Eight route handlers ran at once; the rule was claimed by one.
		expect(answers.filter((from) => from === "once")).toHaveLength(1);
		expect(answers.filter((from) => from === "always")).toHaveLength(7);
		expect(once.hits).toBe(1);
	});

	it("answers 500 when a rule throws, instead of leaving the request hanging", async () => {
		const { stage, page } = await stageOn([rest({ baseURL: "/api" })]);
		await stage.rest.get("/broken", () => {
			throw new Error("bug in the test's resolver");
		});
		const answer = await page.evaluate(async () => {
			const response = await fetch("/api/broken");
			return { status: response.status, body: await response.text() };
		});
		expect(answer.status).toBe(500);
		expect(answer.body).toContain('rule "GET /broken" failed');
		expect(answer.body).toContain("bug in the test's resolver");
		const [fault] = await stage.frames({ protocol: "rest", kind: "fault" });
		expect(fault?.meta["reason"]).toBe("rule-error");
	});

	it("records what the network answered when no route does, once", async () => {
		const { stage, page } = await stageOn([
			rest({ baseURL: "/api", record: true }),
		]);
		// The page reads the body: a response from the network is on the
		// timeline once all of it has arrived, not when its headers have.
		const answer = await page.evaluate(async () => {
			const response = await fetch("/api/unknown");
			return { status: response.status, body: await response.text() };
		});
		expect(answer).toEqual({ status: 404, body: "not stubbed" });
		const calls = await stage.rest.calls();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: "GET", status: 404 });
		expect(calls[0]?.response?.source).toBe("network");
	});

	it("holds a response open that the page reads as the test writes it", async () => {
		const { stage, page } = await stageOn([rest({ baseURL: "/api" })]);
		const watches: RestStream[] = [];
		await stage.rest.get(
			"/watch",
			stream(
				(watch) => {
					watches.push(watch);
				},
				{ contentType: "application/x-ndjson" },
			),
		);
		type Reading = { chunks: string[]; done: Promise<string | null> };
		await page.evaluate(() => {
			const reading = window as unknown as Reading;
			reading.chunks = [];
			reading.done = (async () => {
				const response = await fetch("/api/watch");
				const reader = (
					response.body as ReadableStream<Uint8Array>
				).getReader();
				const decoder = new TextDecoder();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) return response.headers.get("content-type");
					reading.chunks.push(decoder.decode(value));
				}
			})();
		});
		const received = () =>
			page.evaluate(() => (window as unknown as Reading).chunks.join(""));
		await expect.poll(() => watches.length).toBe(1);
		// The page has the first chunk before the second is written.
		await watches[0]?.write('{"n":1}\n');
		await expect.poll(received).toBe('{"n":1}\n');
		await watches[0]?.write('{"n":2}\n');
		await watches[0]?.end();
		expect(await page.evaluate(() => (window as unknown as Reading).done)).toBe(
			"application/x-ndjson",
		);
		expect(await received()).toBe('{"n":1}\n{"n":2}\n');
		const [call] = await stage.rest.calls();
		expect(call).toMatchObject({ method: "GET", status: 200 });
		expect(
			(await stage.frames({ protocol: "rest", kind: "message" })).map((f) =>
				f.payload.text(),
			),
		).toEqual(['{"n":1}\n', '{"n":2}\n']);
	});
});

describe("connect in Chromium", () => {
	/** A gRPC-web unary call made with plain fetch, as connect-web would make it. */
	const grpcWebCall = (text: string) =>
		new Uint8Array(
			encodeEnvelope(
				0,
				toBinary(EchoRequestSchema, create(EchoRequestSchema, { text })),
			),
		);

	it("answers a gRPC-web unary call with the real protocol bytes", async () => {
		const { stage, page } = await stageOn([connect({ baseURL: "/api" })]);
		await stage.connect.unary(EchoService.method.say, (request) => ({
			text: `hello ${request.text}`,
		}));
		const bytes = await page.evaluate(
			async (body) => {
				const response = await fetch("/api/wirestage.test.v1.EchoService/Say", {
					method: "POST",
					headers: {
						"content-type": "application/grpc-web+proto",
						"x-grpc-web": "1",
					},
					body: new Uint8Array(body),
				});
				return [...new Uint8Array(await response.arrayBuffer())];
			},
			[...grpcWebCall("browser")],
		);
		const { envelopes } = decodeEnvelopes(new Uint8Array(bytes));
		expect(
			fromBinary(EchoResponseSchema, envelopes[0]?.data ?? new Uint8Array())
				.text,
		).toBe("hello browser");
		expect(
			parseTrailerBlock(envelopes[1]?.data ?? new Uint8Array())["grpc-status"],
		).toBe("0");
		expect(envelopes[1]?.flags).toBe(EnvelopeFlag.trailer);
	});

	it("records a stubbed call of a recorded service once, as the stub's answer", async () => {
		const { stage, page } = await stageOn([
			connect({ baseURL: "/api", record: [EchoService] }),
		]);
		await stage.connect.unary(EchoService.method.say, { text: "stubbed" });
		await page.evaluate(
			async (body) => {
				const response = await fetch("/api/wirestage.test.v1.EchoService/Say", {
					method: "POST",
					headers: {
						"content-type": "application/grpc-web+proto",
						"x-grpc-web": "1",
					},
					body: new Uint8Array(body),
				});
				await response.arrayBuffer();
			},
			[...grpcWebCall("once")],
		);
		// Two rules saw the request -- the recorder and the stub -- and it is
		// still one call, answered by the stub and not by "the network".
		const calls = await stage.connect.calls(EchoService.method.say);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			caller: "page",
			answeredBy: "stub",
			status: { code: 0 },
		});
		expect(calls[0]?.request?.text).toBe("once");
		expect(calls[0]?.responses.map((message) => message.text)).toEqual([
			"stubbed",
		]);
	});

	it("streams a server stream message by message through the stream server", async () => {
		const { stage, page } = await stageOn([connect({ baseURL: "/api" })]);
		const stub = await stage.connect.stream(EchoService.method.watch);
		// Not awaited: like a real Connect server, the response headers go out
		// with the first message, so the page's fetch() resolves only then.
		await page.evaluate(
			(body) => {
				const state = { chunks: 0, done: false, error: "" };
				(globalThis as unknown as { state: typeof state }).state = state;
				void (async () => {
					try {
						const response = await fetch(
							"/api/wirestage.test.v1.EchoService/Watch",
							{
								method: "POST",
								headers: {
									"content-type": "application/grpc-web+proto",
									"x-grpc-web": "1",
								},
								body: new Uint8Array(body),
							},
						);
						const reader = (
							response.body as ReadableStream<Uint8Array>
						).getReader();
						for (;;) {
							const { done } = await reader.read();
							if (done) break;
							state.chunks += 1;
						}
						state.done = true;
					} catch (error) {
						state.error = String(error);
					}
				})();
			},
			[...grpcWebCall("watch")],
		);
		const call = await stub.next({ timeout: 10_000 });
		expect(call.request.text).toBe("watch");
		const state = () =>
			page.evaluate(
				() =>
					(
						globalThis as unknown as {
							state: { chunks: number; done: boolean };
						}
					).state,
			);
		await call.send({ text: "first" });
		// The page has the first message while the stream is still open.
		await expect
			.poll(async () => (await state()).chunks, { timeout: 10_000 })
			.toBeGreaterThan(0);
		expect((await state()).done).toBe(false);
		await call.fail(Code.Unavailable, "gone");
		await expect(call.closed).resolves.toBe("failed");
		await expect
			.poll(async () => (await state()).done, { timeout: 10_000 })
			.toBe(true);
	});

	it("cuts a live stream so the page sees a network failure", async () => {
		const { stage, page } = await stageOn([connect({ baseURL: "/api" })]);
		const stub = await stage.connect.stream(EchoService.method.watch);
		await page.evaluate(
			(body) => {
				const state = { error: "" };
				(globalThis as unknown as { state: typeof state }).state = state;
				void (async () => {
					try {
						const response = await fetch(
							"/api/wirestage.test.v1.EchoService/Watch",
							{
								method: "POST",
								headers: {
									"content-type": "application/grpc-web+proto",
									"x-grpc-web": "1",
								},
								body: new Uint8Array(body),
							},
						);
						const reader = (
							response.body as ReadableStream<Uint8Array>
						).getReader();
						for (;;) if ((await reader.read()).done) break;
					} catch (error) {
						state.error = String(error);
					}
				})();
			},
			[...grpcWebCall("cut")],
		);
		const call = await stub.next({ timeout: 10_000 });
		await call.send({ text: "before the cut" });
		await call.cut();
		await expect(call.closed).resolves.toBe("cut");
		// A reset is not a status: the call is on record as cut, not as OK.
		const [recorded] = await stage.connect.calls(EchoService.method.watch);
		expect(recorded?.status).toBeUndefined();
		expect(recorded?.fault).toBe("cut");
		expect(recorded?.responses.map((message) => message.text)).toEqual([
			"before the cut",
		]);
		await expect
			.poll(
				() =>
					page.evaluate(
						() =>
							(globalThis as unknown as { state: { error: string } }).state
								.error,
					),
				{
					timeout: 10_000,
				},
			)
			.toContain("TypeError");
	});
});

describe("sse in Chromium", () => {
	it("drives an EventSource, which reconnects through the route after a clean end", async () => {
		const { stage, page } = await stageOn([sse()]);
		const stub = await stage.sse.stream("/events", { retry: 50 });
		await page.evaluate(() => {
			const seen: string[] = [];
			(globalThis as unknown as { seen: string[] }).seen = seen;
			new EventSource("/events").onmessage = (event) => seen.push(event.data);
		});
		const first = await stub.next({ timeout: 10_000 });
		await first.send({ id: "1", data: "one" });
		await expect
			.poll(() =>
				page.evaluate(() => (globalThis as unknown as { seen: string[] }).seen),
			)
			.toEqual(["one"]);
		await first.end();
		const second = await stub.next({ timeout: 10_000 });
		// The reconnect carries the last id, as a real server would see it.
		expect(second.lastEventId).toBe("1");
		expect(first.lastEventId).toBeUndefined();
		await second.send("two");
		await expect
			.poll(() =>
				page.evaluate(() => (globalThis as unknown as { seen: string[] }).seen),
			)
			.toEqual(["one", "two"]);
	});

	it("holds more live streams open than a browser allows one host", async () => {
		// Chromium opens six connections to a host and queues the rest. Streams
		// stay open, so a seventh to one stream server would never start.
		const { stage, page } = await stageOn([sse()]);
		const stub = await stage.sse.stream("/events");
		await page.evaluate(() => {
			const seen: string[] = [];
			(globalThis as unknown as { seen: string[] }).seen = seen;
			for (let i = 0; i < 8; i++)
				new EventSource("/events").onmessage = (event) => seen.push(event.data);
		});
		for (let i = 0; i < 8; i++) {
			const connection = await stub.next({ timeout: 10_000 });
			await connection.send(`stream ${i}`);
		}
		await expect
			.poll(() =>
				page.evaluate(
					() => (globalThis as unknown as { seen: string[] }).seen.length,
				),
			)
			.toBe(8);
	});

	it("closes an EventSource for good when its routed connection is cut", async () => {
		// Chromium treats a reset on a request Playwright redirected as fatal:
		// the EventSource does not reconnect (docs/protocols/sse.md).
		const { stage, page } = await stageOn([sse()]);
		const stub = await stage.sse.stream("/events");
		await page.evaluate(() => {
			const source = new EventSource("/events");
			(globalThis as unknown as { source: EventSource }).source = source;
		});
		const connection = await stub.next({ timeout: 10_000 });
		await connection.cut();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						(globalThis as unknown as { source: EventSource }).source
							.readyState,
				),
			)
			.toBe(2);
	});
});

describe("websocket in Chromium", () => {
	it("plays the server for the page's WebSocket", async () => {
		const { stage, page } = await stageOn([websocket()]);
		const mock = await stage.websocket.mock("ws://localhost:4510/live");
		await page.evaluate(() => {
			const seen: string[] = [];
			(globalThis as unknown as { seen: string[] }).seen = seen;
			const socket = new WebSocket("ws://localhost:4510/live");
			socket.onopen = () => socket.send("hello server");
			socket.onmessage = (event) => seen.push(String(event.data));
		});
		const connection = await mock.next({ timeout: 10_000 });
		await expect(
			connection.nextMessage({ timeout: 10_000 }),
		).resolves.toMatchObject({ data: "hello server" });
		connection.send({ reply: true });
		await expect
			.poll(() =>
				page.evaluate(() => (globalThis as unknown as { seen: string[] }).seen),
			)
			.toEqual(['{"reply":true}']);
	});
});

describe("websocket served to Chromium", () => {
	type Chat = {
		seen: string[];
		protocol: string;
		closed: { code: number; reason: string } | undefined;
		socket: WebSocket;
	};
	const chat = (page: Page) =>
		page.evaluate(() => {
			const { seen, protocol, closed } = (
				globalThis as unknown as { chat: Chat }
			).chat;
			return { seen, protocol, closed };
		});

	it("speaks to the browser's own WebSocket client, both ways and closing", async () => {
		// Lazy and ruleless: the page's WebSocket is the browser's own, not
		// Playwright's stand-in.
		const { stage, context, page } = await stageOn([websocket({ lazy: true })]);
		// A route-fulfilled page reaches a loopback server only with it.
		await context.grantPermissions(["local-network-access"], {
			origin: ORIGIN,
		});
		const server = await stage.websocket.serve();
		const rooms = await server.mock("/chat", {
			onConnect: (connection) => connection.send("welcome"),
		});
		const open = (url: string) =>
			page.evaluate((target) => {
				const state: Chat = {
					seen: [],
					protocol: "",
					closed: undefined,
					socket: new WebSocket(target, ["v2", "v1"]),
				};
				(globalThis as unknown as { chat: Chat }).chat = state;
				const { socket } = state;
				socket.binaryType = "arraybuffer";
				socket.onopen = () => {
					state.protocol = socket.protocol;
					// Over 65,535 bytes: the 64-bit length, masked by the browser.
					socket.send("x".repeat(70_000));
					socket.send(new Uint8Array([1, 2, 3]));
				};
				socket.onmessage = (event) =>
					state.seen.push(
						typeof event.data === "string"
							? event.data
							: `bytes:${new Uint8Array(event.data as ArrayBuffer).length}`,
					);
				socket.onclose = (event) => {
					state.closed = { code: event.code, reason: event.reason };
				};
			}, url);
		await open(`${server.url}/chat`);
		const connection = await rooms.next({ timeout: 10_000 });
		expect(
			(await connection.nextMessage({ timeout: 10_000 })).text(),
		).toHaveLength(70_000);
		expect([...((await connection.nextMessage()).data as Uint8Array)]).toEqual([
			1, 2, 3,
		]);
		connection.send(new Uint8Array(300));
		await expect
			.poll(async () => (await chat(page)).seen)
			.toEqual(["welcome", "bytes:300"]);
		await connection.close({ code: 4000, reason: "done" });
		expect(await chat(page)).toEqual({
			seen: ["welcome", "bytes:300"],
			protocol: "v2",
			closed: { code: 4000, reason: "done" },
		});
		// And a close the browser starts.
		await open(`${server.url}/chat`);
		const second = await rooms.next({ timeout: 10_000 });
		// Open on the page's side too. The server takes the connection before
		// the browser has read its 101, and a socket closed while it is still
		// connecting fails its handshake instead: Chromium sends 1001.
		await expect.poll(async () => (await chat(page)).protocol).toBe("v2");
		await page.evaluate(() =>
			(globalThis as unknown as { chat: Chat }).chat.socket.close(4001, "bye"),
		);
		await expect(second.closed).resolves.toEqual({ code: 4001, reason: "bye" });
		expect(
			(await server.frames())
				.filter((f) => f.kind === "lifecycle")
				.map((f) => [f.meta["event"], f.source]),
		).toEqual([
			["open", "network"],
			["close", "server"],
			["open", "network"],
			["close", "network"],
		]);
	});
});

describe("websocket closes in Chromium", () => {
	interface PageSocket {
		seen: string[];
		closed?: { code: number; reason: string; clean: boolean };
		socket: WebSocket;
	}
	const openSocket = (page: Page, url: string) =>
		page.evaluate((target) => {
			const socket = new WebSocket(target);
			const state: PageSocket = { seen: [], socket };
			(globalThis as unknown as { ws: PageSocket }).ws = state;
			socket.onopen = () => socket.send("hello server");
			socket.onmessage = (event) => state.seen.push(String(event.data));
			socket.onclose = (event) => {
				state.closed = {
					code: event.code,
					reason: event.reason,
					clean: event.wasClean,
				};
			};
		}, url);
	const pageSocket = (page: Page) =>
		page.evaluate(() => {
			const { seen, closed, socket } = (
				globalThis as unknown as { ws: PageSocket }
			).ws;
			return { seen, closed, readyState: socket.readyState };
		});

	it("finishes a close the page starts on a mocked socket", async () => {
		const { stage, page } = await stageOn([websocket()]);
		const mock = await stage.websocket.mock("ws://localhost:4510/live");
		await openSocket(page, "ws://localhost:4510/live");
		const connection = await mock.next({ timeout: 10_000 });
		await connection.nextMessage({ timeout: 10_000 });
		await page.evaluate(() =>
			(globalThis as unknown as { ws: PageSocket }).ws.socket.close(
				4001,
				"done",
			),
		);
		await expect(connection.closed).resolves.toEqual({
			code: 4001,
			reason: "done",
		});
		// CLOSED, not stuck in CLOSING: the fake server answered the close.
		await expect
			.poll(async () => (await pageSocket(page)).closed)
			.toEqual({ code: 4001, reason: "done", clean: true });
		expect((await pageSocket(page)).readyState).toBe(3);
	});

	it("closes a mocked socket from the test with any code a server may send", async () => {
		const { stage, page } = await stageOn([websocket()]);
		const mock = await stage.websocket.mock("ws://localhost:4510/live");
		await openSocket(page, "ws://localhost:4510/live");
		const connection = await mock.next({ timeout: 10_000 });
		await connection.close({ code: 1001, reason: "restarting" });
		await expect(connection.closed).resolves.toEqual({
			code: 1001,
			reason: "restarting",
		});
		await expect
			.poll(async () => (await pageSocket(page)).closed)
			.toMatchObject({ code: 1001, reason: "restarting" });
	});

	/** A proxy in front of a real server; the page reaches loopback through it. */
	async function proxied(options: Parameters<typeof stageProxy>[1] = {}) {
		const server = await webSocketServer();
		disposers.push(server.close);
		const opened = await stageOn([websocket()]);
		// The page's origin is fulfilled by a route, so Chromium cannot place
		// it in an address space and would refuse it the loopback server.
		await opened.context
			.grantPermissions(["local-network-access"])
			.catch(() => undefined);
		const proxy = await stageProxy(opened.stage, options, server.url);
		await openSocket(opened.page, `${server.url}/live`);
		const connection = await proxy.next({ timeout: 10_000 });
		const real = await server.next();
		await expect.poll(() => real.received).toEqual(["hello server"]);
		return { ...opened, proxy, connection, real };
	}
	const stageProxy = (
		stage: Awaited<
			ReturnType<typeof stageOn<readonly [ReturnType<typeof websocket>]>>
		>["stage"],
		options: Parameters<typeof stage.websocket.proxy>[1],
		url: string,
	) => stage.websocket.proxy(`${url}/**`, options);

	it("proxies a real server: both directions, drops and injections", async () => {
		const { stage, page, connection, real } = await proxied({
			drop: (message) =>
				message.direction === "in" && message.text() === "heartbeat",
		});
		real.send("heartbeat");
		real.send("update");
		await expect
			.poll(async () => (await pageSocket(page)).seen)
			.toEqual(["update"]);
		connection.toPage("from the test");
		connection.toServer("as the page");
		await expect
			.poll(async () => (await pageSocket(page)).seen)
			.toEqual(["update", "from the test"]);
		await expect
			.poll(() => real.received)
			.toEqual(["hello server", "as the page"]);
		const frames = await stage.websocket.frames();
		expect(
			frames
				.filter((frame) => frame.kind !== "lifecycle")
				.map((frame) => [
					frame.kind,
					frame.direction,
					frame.source,
					frame.payload.text(),
				]),
		).toEqual([
			["message", "out", "page", "hello server"],
			// The drop is the proxy's doing, so the fault is a stub's.
			["fault", "in", "stub", "heartbeat"],
			["message", "in", "network", "update"],
			["message", "in", "test", "from the test"],
			["message", "out", "test", "as the page"],
		]);
	});

	it("carries a close the page starts through to the real server", async () => {
		const { page, connection, real } = await proxied();
		await page.evaluate(() =>
			(globalThis as unknown as { ws: PageSocket }).ws.socket.close(
				4001,
				"done",
			),
		);
		await expect(real.closed).resolves.toEqual({ code: 4001, reason: "done" });
		await expect(connection.closed).resolves.toEqual({
			code: 4001,
			reason: "done",
		});
		await expect.poll(async () => (await pageSocket(page)).readyState).toBe(3);
	});

	it("carries a close the real server starts through to the page", async () => {
		const { page, connection, real } = await proxied();
		real.close(4002, "server is done");
		await expect(connection.closed).resolves.toEqual({
			code: 4002,
			reason: "server is done",
		});
		await expect
			.poll(async () => (await pageSocket(page)).closed)
			.toMatchObject({ code: 4002, reason: "server is done" });
	});

	it("closes both ends from the test, with a code only a server may send", async () => {
		const { page, connection, real } = await proxied();
		// 1001 is "going away": a server sends it, a script may not. The page
		// gets it as given. The real server is closed through the browser,
		// which would refuse the code and leave the connection open — so it
		// goes as a normal closure.
		await connection.close({ code: 1001, reason: "restarting" });
		await expect
			.poll(async () => (await pageSocket(page)).closed)
			.toMatchObject({ code: 1001, reason: "restarting" });
		await expect(real.closed).resolves.toEqual({
			code: 1000,
			reason: "restarting",
		});
	});
});

describe("webrtc in Chromium", () => {
	/** Two peers in one page, connected over loopback, with one data channel. */
	const LOOPBACK = `<!doctype html><script>
		window.connect = async () => {
			const a = new RTCPeerConnection();
			const b = new RTCPeerConnection();
			a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
			b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
			const received = [];
			window.received = received;
			b.ondatachannel = (e) => {
				window.remote = e.channel;
				e.channel.binaryType = "arraybuffer";
				e.channel.onmessage = (m) => received.push(typeof m.data === "string" ? m.data : [...new Uint8Array(m.data)]);
			};
			const channel = a.createDataChannel("room/cursor");
			window.local = channel;
			await a.setLocalDescription(await a.createOffer());
			await b.setRemoteDescription(a.localDescription);
			await b.setLocalDescription(await b.createAnswer());
			await a.setRemoteDescription(b.localDescription);
			await new Promise((resolve) => (channel.onopen = resolve));
			await new Promise((resolve) => { const wait = () => (window.remote && window.remote.readyState === "open" ? resolve() : setTimeout(wait, 10)); wait(); });
		};
	</script>`;

	it("records, suppresses and injects on a real data channel", async () => {
		const { stage, page } = await stageOn([webrtc()], LOOPBACK);
		await page.evaluate(() =>
			(window as unknown as { connect(): Promise<void> }).connect(),
		);
		await page.evaluate(() =>
			(window as unknown as { local: RTCDataChannel }).local.send(
				new Uint8Array([1, 2, 3]),
			),
		);
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as { received: unknown[] }).received,
				),
			)
			.toEqual([[1, 2, 3]]);
		const sent = await stage.webrtc.messages("room/cursor", {
			direction: "out",
		});
		expect(sent[0]?.payload.bytes()).toEqual(new Uint8Array([1, 2, 3]));
		const inbound = await stage.webrtc.messages("room/cursor", {
			direction: "in",
		});
		expect(inbound[0]?.payload.bytes()).toEqual(new Uint8Array([1, 2, 3]));

		const restore = await stage.webrtc.suppress("room/cursor");
		await page.evaluate(() =>
			(window as unknown as { local: RTCDataChannel }).local.send("dropped"),
		);
		await expect
			.poll(async () => (await stage.webrtc.frames({ kind: "fault" })).length)
			.toBe(1);
		expect(
			await page.evaluate(
				() => (window as unknown as { received: unknown[] }).received,
			),
		).toHaveLength(1);
		await restore();

		expect(await stage.webrtc.inject("room/cursor", "from the test")).toBe(2);
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as { received: unknown[] }).received,
				),
			)
			.toEqual([[1, 2, 3], "from the test"]);
		await expect(
			stage.webrtc.waitForChannel("room/cursor"),
		).resolves.toMatchObject({ endpoint: "room/cursor" });
	});

	it("reaches a data channel that lives in an iframe", async () => {
		// A flush window far longer than the test: only the read's own flush,
		// which has to reach the child frame, can deliver what is buffered.
		const { stage, context, page } = await stageOn(
			[webrtc()],
			"<!doctype html><title>outer</title>",
			60_000,
		);
		await context.route(`${ORIGIN}/frame`, (route) =>
			route.fulfill({ status: 200, contentType: "text/html", body: LOOPBACK }),
		);
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					const frame = document.createElement("iframe");
					frame.src = "/frame";
					frame.onload = () => resolve();
					document.body.append(frame);
				}),
		);
		const inner = page.frames().find((frame) => frame !== page.mainFrame());
		if (inner === undefined) throw new Error("the iframe did not load");
		await inner.evaluate(() =>
			(window as unknown as { connect(): Promise<void> }).connect(),
		);
		await inner.evaluate(() => {
			const { local } = window as unknown as { local: RTCDataChannel };
			for (const text of ["one", "two", "three"]) local.send(text);
		});
		const sent = await stage.webrtc.messages("room/cursor", {
			direction: "out",
		});
		expect(sent.map((frame) => frame.payload.text())).toEqual([
			"one",
			"two",
			"three",
		]);
		// Commands reach the frame too: both ends of the channel are in it.
		expect(await stage.webrtc.inject("room/cursor", "to the frame")).toBe(2);
		await expect
			.poll(() =>
				inner.evaluate(
					() => (window as unknown as { received: unknown[] }).received,
				),
			)
			.toContain("to the frame");
	});
});
