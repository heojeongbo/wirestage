import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFakeContext,
	createFakeWebSocketRoute,
	type FakeContext,
	type FakeWebSocketRoute,
} from "../../../__fixtures__/fake-playwright.js";
import { createTimeline } from "../../../entities/frame/index.js";
import type { SocketRule, SocketView } from "../../../entities/plugin/index.js";
import { createManualClock } from "../../../shared/lib/clock/index.js";
import { createSequence } from "../../../shared/lib/id/index.js";
import { createScopedLogger } from "../../../shared/lib/logger/index.js";
import type { AttachedContext } from "./attached-context.js";
import { createSocketRouter } from "./socket-router.js";

afterEach(() => vi.restoreAllMocks());

const attachmentOf = (id: string, context: FakeContext): AttachedContext => ({
	id,
	context,
	cookies: context,
	baseURL: undefined,
});

function setup() {
	const timeline = createTimeline({ clock: createManualClock() });
	const log = createScopedLogger("Socket");
	const router = createSocketRouter({
		timeline,
		log,
		correlation: createSequence("w"),
	});
	const context = createFakeContext();
	const attachment = attachmentOf("c1", context);
	return { timeline, log, router, context, attachment };
}

function recorder(over: Partial<SocketRule> = {}) {
	const sockets: SocketView[] = [];
	const rule: SocketRule = {
		protocol: "ws",
		label: "test rule",
		url: "/live",
		open: (socket) => {
			sockets.push(socket);
		},
		...over,
	};
	return { rule, sockets };
}

const open = (context: FakeContext, path = "/live") =>
	context.openWebSocket(`ws://app.test${path}`);

describe("socket router", () => {
	it("gives a matching socket to its rule, with both ends to drive", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		const { rule, sockets } = recorder();
		const handle = await router.add(rule);
		const route = (await open(context)) as FakeWebSocketRoute;
		const [socket] = sockets as [SocketView];
		expect(socket).toMatchObject({ correlation: "w1", context: "c1" });
		expect(socket.url.href).toBe("ws://app.test/live");
		expect(handle.hits).toBe(1);

		const fromPage: (string | Uint8Array)[] = [];
		const closes: unknown[] = [];
		socket.page.onMessage((data) => fromPage.push(data));
		socket.page.onClose((code, reason) => closes.push([code, reason]));
		route.receive("hello");
		expect(fromPage).toEqual(["hello"]);

		socket.page.send("text");
		socket.page.send(new Uint8Array([1, 2]));
		expect(route.sent).toEqual(["text", Buffer.from([1, 2])]);
		await socket.page.close({ code: 4000, reason: "bye" });
		expect(route.closedWith).toEqual([{ code: 4000, reason: "bye" }]);
		// A close the rule starts is reported to its own handler too.
		expect(closes).toEqual([[4000, "bye"]]);

		// The server's end is opened once, however often it is asked for.
		const server = socket.connectToServer();
		expect(socket.connectToServer()).toBe(server);
		server.send("to server");
		expect(route.server?.sent).toEqual(["to server"]);
	});

	it("closes the server's end as the browser can, whatever was asked", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		const { rule, sockets } = recorder();
		await router.add(rule);
		const closeServer = async (options?: {
			code?: number;
			reason?: string;
		}) => {
			const page = (await open(context)) as FakeWebSocketRoute;
			const socket = sockets.at(-1) as SocketView;
			await socket.connectToServer().close(options);
			// Never a close the browser would throw on: Playwright swallows
			// that, and the server would stay connected.
			expect(page.server?.refusedCloses).toEqual([]);
			return page.server?.closedWith;
		};
		// 1001 is the browser's own "going away": a script may not send it.
		expect(await closeServer({ code: 1001, reason: "restarting" })).toEqual([
			{ code: 1000, reason: "restarting" },
		]);
		expect(await closeServer({ code: 1006 })).toEqual([{ code: 1000 }]);
		// Nor a reason without a code, which the browser reads as code 0.
		expect(await closeServer({ reason: "bye" })).toEqual([
			{ code: 1000, reason: "bye" },
		]);
		// Nor a reason over the 123 bytes a close frame carries: it is cut to
		// fit, on a whole character — "é" is two bytes, "😀" four.
		expect(await closeServer({ code: 4000, reason: "é".repeat(100) })).toEqual([
			{ code: 4000, reason: "é".repeat(61) },
		]);
		expect(
			await closeServer({ code: 1001, reason: `${"a".repeat(121)}😀` }),
		).toEqual([{ code: 1000, reason: "a".repeat(121) }]);
		// What the browser accepts goes through as given.
		expect(await closeServer({ code: 4000, reason: "b".repeat(123) })).toEqual([
			{ code: 4000, reason: "b".repeat(123) },
		]);
		expect(await closeServer({ code: 4000 })).toEqual([{ code: 4000 }]);
		expect(await closeServer({})).toEqual([{}]);
		expect(await closeServer()).toEqual([undefined]);
		// The page's end takes any code and any reason: Playwright closes it
		// without asking the browser.
		const page = (await open(context)) as FakeWebSocketRoute;
		await (sockets.at(-1) as SocketView).page.close({
			code: 1001,
			reason: "é".repeat(100),
		});
		expect(page.closedWith).toEqual([{ code: 1001, reason: "é".repeat(100) }]);
	});

	it("passes no message on for a rule that only connects, but passes closes on", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		await router.add(
			recorder({
				open: (socket) => {
					socket.connectToServer();
				},
			}).rule,
		);
		const page = (await open(context)) as FakeWebSocketRoute;
		const server = page.server as FakeWebSocketRoute;
		// Playwright would carry both over, and no frame would record them.
		page.receive("up");
		server.receive("down");
		expect(server.sent).toEqual([]);
		expect(page.sent).toEqual([]);
		// A close nobody handles still reaches the other end.
		page.closeFromPeer(4000, "bye");
		expect(server.closedWith).toEqual([{ code: 4000, reason: "bye" }]);
	});

	it("drops the direction a rule does not wire, whichever it wires", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		const { rule, sockets } = recorder();
		await router.add(rule);
		const pageToServer = (await open(context)) as FakeWebSocketRoute;
		const one = sockets.at(-1) as SocketView;
		// Set after connecting: the rule's handler replaces the one that drops.
		const upstream = one.connectToServer();
		one.page.onMessage((data) => upstream.send(data));
		pageToServer.receive("up");
		pageToServer.server?.receive("down");
		expect(pageToServer.server?.sent).toEqual(["up"]);
		expect(pageToServer.sent).toEqual([]);

		const serverToPage = (await open(context)) as FakeWebSocketRoute;
		const other = sockets.at(-1) as SocketView;
		other.connectToServer().onMessage((data) => other.page.send(data));
		serverToPage.receive("up");
		serverToPage.server?.receive("down");
		expect(serverToPage.server?.sent).toEqual([]);
		expect(serverToPage.sent).toEqual(["down"]);
	});

	it("lets the newest rule take the socket, across every rule added", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		const older = recorder();
		const newer = recorder();
		await router.add(older.rule);
		const handle = await router.add(newer.rule);
		await open(context);
		expect(newer.sockets).toHaveLength(1);
		expect(older.sockets).toHaveLength(0);
		await handle.remove();
		expect(handle.active).toBe(false);
		await open(context);
		expect(older.sockets).toHaveLength(1);
		// Removing twice is harmless.
		await handle.remove();
	});

	it("leaves a socket no rule wants to the real server", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		const { rule } = recorder();
		const handle = await router.add(rule);
		expect(await open(context, "/other")).toBeUndefined();
		await handle.remove();
		expect(await open(context)).toBeUndefined();
	});

	it("stops taking sockets after `times` connections", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		const { rule, sockets } = recorder({ times: 2 });
		const handle = await router.add(rule);
		await open(context);
		expect(handle.active).toBe(true);
		await open(context);
		expect(handle.active).toBe(false);
		expect(await open(context)).toBeUndefined();
		expect(sockets).toHaveLength(2);
		await expect(router.add(recorder({ times: 0 }).rule)).rejects.toMatchObject(
			{ code: "INVALID_ARGUMENT" },
		);
	});

	it("leaves the page's WebSocket alone until there is a rule", async () => {
		const { router, context, attachment } = setup();
		const routeWebSocket = vi.spyOn(context, "routeWebSocket");
		await router.attach(attachment);
		// Routing replaces `WebSocket` in every document: not without a reason.
		expect(routeWebSocket).not.toHaveBeenCalled();
		await router.add(recorder().rule);
		await router.add(recorder().rule);
		expect(routeWebSocket).toHaveBeenCalledTimes(1);
		// A context attached once rules exist is routed from the start.
		const late = createFakeContext();
		const lateRoute = vi.spyOn(late, "routeWebSocket");
		await router.attach(attachmentOf("c2", late));
		expect(lateRoute).toHaveBeenCalledTimes(1);
	});

	it("routes from attach when a plugin asked for it up front", async () => {
		const { router, context, attachment } = setup();
		const routeWebSocket = vi.spyOn(context, "routeWebSocket");
		router.prepare();
		await router.attach(attachment);
		// No rule yet, but the hook is in: a rule added mid-test will reach
		// the pages that are already open.
		expect(routeWebSocket).toHaveBeenCalledTimes(1);
		expect(await open(context)).toBeUndefined();
		const { rule, sockets } = recorder();
		await router.add(rule);
		expect(routeWebSocket).toHaveBeenCalledTimes(1);
		await open(context);
		expect(sockets).toHaveLength(1);
	});

	it("stops routing a detached context, though its route stays in the browser", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		const { rule, sockets } = recorder();
		await router.add(rule);
		router.detach(attachment);
		expect(await open(context)).toBeUndefined();
		expect(sockets).toHaveLength(0);
		// Attached again, it is a new attachment with a route of its own.
		await router.attach(attachmentOf("c2", context));
		await open(context);
		expect(sockets.map((socket) => socket.context)).toEqual(["c2"]);
	});

	it("passes a socket through when its rule or context went between check and call", async () => {
		const harness = setup();
		let handler: ((route: FakeWebSocketRoute) => unknown) | undefined;
		vi.spyOn(harness.context, "routeWebSocket").mockImplementation(
			async (_predicate, h) => {
				handler = h as typeof handler;
			},
		);
		await harness.router.attach(harness.attachment);
		const { rule, sockets } = recorder();
		const handle = await harness.router.add(rule);
		await handle.remove();
		const removed = createFakeWebSocketRoute("ws://app.test/live");
		await handler?.(removed);
		expect(removed.server).toBeDefined();

		await harness.router.add(rule);
		harness.router.detach(harness.attachment);
		const detached = createFakeWebSocketRoute("ws://app.test/live");
		await handler?.(detached);
		expect(detached.server).toBeDefined();
		expect(sockets).toHaveLength(0);
	});

	it("waits for an async rule before Playwright opens the page's end", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		let wired = false;
		await router.add(
			recorder({
				open: async () => {
					await Promise.resolve();
					wired = true;
				},
			}).rule,
		);
		await open(context);
		// The handler Playwright awaits has settled: the rule is wired up.
		expect(wired).toBe(true);
	});

	it("closes both ends of a socket whose rule throws, and says which rule failed", async () => {
		const { router, context, attachment, log, timeline } = setup();
		await router.attach(attachment);
		const error = vi.spyOn(log, "error").mockImplementation(() => {});
		await router.add(
			recorder({
				label: "broken",
				open: async (socket) => {
					socket.connectToServer();
					await Promise.resolve();
					throw new Error("bug in the rule");
				},
			}).rule,
		);
		// Resolves: nothing rejects into Playwright.
		const page = (await open(context)) as FakeWebSocketRoute;
		const reason = 'wirestage: rule "broken" failed: bug in the rule';
		// Not left open with nobody answering it: a server's internal error.
		expect(page.closedWith).toEqual([{ code: 1011, reason }]);
		// Playwright's own forwarding of that close is refused (a script may
		// not send 1011), so the server the rule connected is closed by hand.
		expect(page.server?.refusedCloses).toEqual([{ code: 1011, reason }]);
		expect(page.server?.closedWith).toEqual([{ code: 1000, reason }]);
		expect(timeline.frames()).toEqual([
			expect.objectContaining({
				protocol: "ws",
				kind: "fault",
				direction: "none",
				source: "stub",
				endpoint: "/live",
				correlation: "w1",
				context: "c1",
				meta: {
					reason: "rule-error",
					rule: "broken",
					error: "bug in the rule",
				},
			}),
		]);
		expect(error).toHaveBeenCalledWith(
			"socket rule failed",
			{ rule: "broken", url: "ws://app.test/live" },
			expect.any(Error),
		);

		// Thrown before connecting, and not an Error: the page's end alone,
		// with a reason cut to the 123 bytes a close frame carries — on a
		// whole character, "é" being two bytes.
		await router.add(
			recorder({
				label: `a${"é".repeat(60)}`,
				open: () => {
					throw "not an Error";
				},
			}).rule,
		);
		const second = (await open(context)) as FakeWebSocketRoute;
		expect(second.server).toBeUndefined();
		expect(second.closedWith).toEqual([
			{ code: 1011, reason: `wirestage: rule "a${"é".repeat(52)}` },
		]);
		expect(timeline.last()?.meta).toMatchObject({ error: "not an Error" });
	});

	it("treats a URL matcher that throws as no match, for that rule alone", async () => {
		const { router, context, attachment, log } = setup();
		await router.attach(attachment);
		const error = vi.spyOn(log, "error").mockImplementation(() => {});
		const older = recorder();
		await router.add(older.rule);
		await router.add(
			recorder({
				label: "broken matcher",
				url: () => {
					throw new Error("bug in the predicate");
				},
			}).rule,
		);
		await open(context);
		expect(older.sockets).toHaveLength(1);
		expect(error).toHaveBeenCalledWith(
			"rule's URL matcher failed",
			{ rule: "broken matcher", url: "ws://app.test/live" },
			expect.any(Error),
		);
	});

	it("takes back a rule it could not install everywhere", async () => {
		const { router, context, attachment } = setup();
		await router.attach(attachment);
		const routeWebSocket = vi
			.spyOn(context, "routeWebSocket")
			.mockRejectedValueOnce(new Error("context closed"));
		await expect(router.add(recorder().rule)).rejects.toThrow("context closed");
		// Not half-installed: the next rule installs the route afresh.
		const { rule, sockets } = recorder();
		await router.add(rule);
		expect(routeWebSocket).toHaveBeenCalledTimes(2);
		await open(context);
		expect(sockets).toHaveLength(1);
	});
});
