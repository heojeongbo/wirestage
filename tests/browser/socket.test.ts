/**
 * The socket router against a real Chromium: what Playwright's WebSocket
 * route does on its own — which the fakes model — and what the router makes
 * of it: a rule that throws, an end no rule wired, a close the browser
 * refuses to send.
 */
import type { BrowserContext, Page, WebSocketRoute } from "@playwright/test";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
	type AnyWirePlugin,
	createDeferred,
	createStage,
	definePlugin,
	type SocketView,
} from "../../src/index.js";
import { websocket } from "../../src/websocket.js";
import { close, contextWithPage, ORIGIN, webSocketServer } from "./harness.js";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});
afterAll(close);

/**
 * A page on ORIGIN that may reach a loopback server, loaded once `route`
 * is in: Playwright routes WebSockets by replacing `WebSocket` in each
 * document as it loads.
 */
async function loaded(
	route: (context: BrowserContext) => Promise<unknown>,
): Promise<Page> {
	const { context, page } = await contextWithPage(
		"<!doctype html><title>t</title>",
	);
	disposers.push(() => context.close());
	// The page's origin is fulfilled by a route, so Chromium cannot place it
	// in an address space and would refuse it the loopback server.
	await context
		.grantPermissions(["local-network-access"])
		.catch(() => undefined);
	await route(context);
	await page.goto(`${ORIGIN}/`);
	return page;
}

async function staged<const Plugins extends readonly AnyWirePlugin[]>(
	plugins: Plugins,
) {
	const stage = createStage({ plugins, pageFlushMs: 5 });
	const page = await loaded((context) =>
		stage.attach(context, { baseURL: ORIGIN }),
	);
	// Disposed before its context is closed.
	disposers.push(() => stage.dispose());
	return { stage, page };
}

async function realServer() {
	const server = await webSocketServer();
	disposers.push(server.close);
	return server;
}

/** A plugin with one socket rule, whose `open` is the test's. */
const tap = (open: (socket: SocketView) => void | Promise<void>) =>
	definePlugin({
		name: "tap",
		setup(context) {
			context.sockets.prepare();
			return {
				api: {
					take: (url: string) =>
						context.sockets.add({
							protocol: context.name,
							label: "tap",
							url: `${url}/**`,
							open,
						}),
				},
			};
		},
	});

interface PageSocket {
	events: string[];
	socket: WebSocket;
}

/** Open a socket that greets on open and writes down what happens to it. */
const openSocket = (page: Page, url: string) =>
	page.evaluate((target) => {
		const socket = new WebSocket(target);
		const state: PageSocket = { events: [], socket };
		(globalThis as unknown as { ws: PageSocket }).ws = state;
		socket.onopen = () => {
			state.events.push("open");
			socket.send("hello server");
		};
		socket.onmessage = (event) => state.events.push(`message ${event.data}`);
		socket.onclose = (event) =>
			state.events.push(`close ${event.code} ${event.reason}`);
	}, url);

const pageSocket = (page: Page) =>
	page.evaluate(() => {
		const { events, socket } = (globalThis as unknown as { ws: PageSocket }).ws;
		return { events, readyState: socket.readyState };
	});

const closePageSocket = (page: Page, code: number, reason: string) =>
	page.evaluate(
		([closeCode, closeReason]) =>
			(globalThis as unknown as { ws: PageSocket }).ws.socket.close(
				closeCode,
				closeReason,
			),
		[code, reason] as const,
	);

describe("Playwright's WebSocket route, as the fakes model it", () => {
	it("passes the messages of an end with no handler on to the other end", async () => {
		const server = await realServer();
		const page = await loaded((context) =>
			context.routeWebSocket(`${server.url}/**`, (route) => {
				route.connectToServer();
			}),
		);
		await openSocket(page, `${server.url}/live`);
		const real = await server.next();
		await expect.poll(() => real.received).toEqual(["hello server"]);
		real.send("from the server");
		await expect
			.poll(async () => (await pageSocket(page)).events)
			.toEqual(["open", "message from the server"]);
	});

	it("leaves the server's end open on a close whose reason is over 123 bytes", async () => {
		const server = await realServer();
		const connected = createDeferred<WebSocketRoute>();
		const page = await loaded((context) =>
			context.routeWebSocket(`${server.url}/**`, (route) => {
				connected.resolve(route.connectToServer());
			}),
		);
		await openSocket(page, `${server.url}/live`);
		const upstream = await connected.promise;
		const real = await server.next();
		await expect.poll(() => real.received).toEqual(["hello server"]);
		// The browser throws on it and Playwright swallows that: no close
		// goes out, and the connection still carries messages.
		await upstream.close({ code: 4000, reason: "x".repeat(124) });
		upstream.send("still open");
		await expect
			.poll(() => real.received)
			.toEqual(["hello server", "still open"]);
		await upstream.close({ code: 4000, reason: "x".repeat(123) });
		await expect(real.closed).resolves.toEqual({
			code: 4000,
			reason: "x".repeat(123),
		});
	});
});

describe("socket rules in Chromium", () => {
	it("closes the page's socket when the rule throws, and records the fault", async () => {
		const { stage, page } = await staged([
			tap(() => {
				throw new Error("bug in open");
			}),
		]);
		await stage.tap.take("ws://localhost:4510");
		await openSocket(page, "ws://localhost:4510/live");
		// Not left open with nobody answering it. The rule failed before the
		// page's end opened, so the page hears of the close alone.
		await expect
			.poll(() => pageSocket(page))
			.toEqual({
				events: ['close 1011 wirestage: rule "tap" failed: bug in open'],
				readyState: 3,
			});
		const faults = await stage.frames({ protocol: "tap", kind: "fault" });
		expect(faults.map((frame) => frame.meta)).toEqual([
			{ reason: "rule-error", rule: "tap", error: "bug in open" },
		]);
	});

	it("closes the real server's end too, when the rule connected it", async () => {
		const server = await realServer();
		const { stage, page } = await staged([
			tap(async (socket) => {
				const upstream = socket.connectToServer();
				// Fail once the server's end is open, so its close is a real
				// closing handshake.
				await new Promise((resolve) => upstream.onMessage(resolve));
				throw new Error("bug after connecting");
			}),
		]);
		await stage.tap.take(server.url);
		await openSocket(page, `${server.url}/live`);
		const real = await server.next();
		real.send("hello page");
		const reason = 'wirestage: rule "tap" failed: bug after connecting';
		// A script may not send 1011: the server gets a normal closure.
		await expect(real.closed).resolves.toEqual({ code: 1000, reason });
		await expect
			.poll(async () => (await pageSocket(page)).events)
			.toEqual(["open", `close 1011 ${reason}`]);
	});

	it("fails a proxy whose drop throws, instead of throwing into Playwright", async () => {
		const server = await realServer();
		const { stage, page } = await staged([websocket()]);
		const pattern = `${server.url}/**`;
		const proxy = await stage.websocket.proxy(pattern, {
			drop: () => {
				throw new Error("bug in drop");
			},
		});
		// The page greets on open: the first message, and the first call.
		await openSocket(page, `${server.url}/live`);
		const connection = await proxy.next({ timeout: 10_000 });
		const real = await server.next();
		const reason = `wirestage: rule "proxy ${pattern}" failed: bug in drop`;
		// Called from Playwright's own event dispatch, the throw would be an
		// uncaught exception, and the socket would stay open.
		await expect(real.closed).resolves.toEqual({ code: 1000, reason });
		await expect
			.poll(async () => (await pageSocket(page)).events)
			.toEqual(["open", `close 1011 ${reason}`]);
		// Its close frame is written as it closes, whichever end reports first.
		await connection.closed;
		const frames = await stage.websocket.frames();
		expect(
			frames.map((frame) => [
				frame.kind,
				frame.source,
				frame.meta["event"] ?? frame.meta["reason"],
			]),
		).toEqual([
			["lifecycle", "page", "open"],
			["fault", "stub", "rule-error"],
			["lifecycle", "stub", "close"],
		]);
		expect(real.received).toEqual([]);
	});

	it("passes no message on for a rule that only connects, but passes closes on", async () => {
		const server = await realServer();
		const { stage, page } = await staged([
			tap((socket) => {
				socket.connectToServer();
			}),
		]);
		await stage.tap.take(server.url);

		// The page greets, then closes. The close reaches the server; a
		// greeting passed on would have reached it first.
		await openSocket(page, `${server.url}/live`);
		const first = await server.next();
		await expect
			.poll(async () => (await pageSocket(page)).events)
			.toEqual(["open"]);
		await closePageSocket(page, 4001, "page is done");
		await expect(first.closed).resolves.toEqual({
			code: 4001,
			reason: "page is done",
		});
		expect(first.received).toEqual([]);

		// The server speaks, then closes: the page hears of the close alone.
		await openSocket(page, `${server.url}/live`);
		const second = await server.next();
		second.send("from the server");
		second.close(4002, "server is done");
		await expect
			.poll(async () => (await pageSocket(page)).events)
			.toEqual(["open", "close 4002 server is done"]);
	});

	it("drops the direction a rule does not wire", async () => {
		const server = await realServer();
		const { stage, page } = await staged([
			tap((socket) => {
				const upstream = socket.connectToServer();
				socket.page.onMessage((data) => upstream.send(data));
			}),
		]);
		await stage.tap.take(server.url);
		await openSocket(page, `${server.url}/live`);
		const real = await server.next();
		await expect.poll(() => real.received).toEqual(["hello server"]);
		real.send("from the server");
		real.close(4002, "server is done");
		await expect
			.poll(async () => (await pageSocket(page)).events)
			.toEqual(["open", "close 4002 server is done"]);
	});

	it("closes a proxy's server with the reason cut to fit, the page with all of it", async () => {
		const server = await realServer();
		const { stage, page } = await staged([websocket()]);
		const proxy = await stage.websocket.proxy(`${server.url}/**`);
		await openSocket(page, `${server.url}/live`);
		const connection = await proxy.next({ timeout: 10_000 });
		const real = await server.next();
		await expect.poll(() => real.received).toEqual(["hello server"]);
		// 200 bytes: "é" is two. A close frame carries 123, and the browser
		// would refuse the rest and leave the server connected.
		const reason = "é".repeat(100);
		await connection.close({ code: 4000, reason });
		await expect(real.closed).resolves.toEqual({
			code: 4000,
			reason: "é".repeat(61),
		});
		await expect
			.poll(async () => (await pageSocket(page)).events)
			.toEqual(["open", `close 4000 ${reason}`]);
	});
});
