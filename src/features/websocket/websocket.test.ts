import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFakeContext,
	type FakeWebSocketRoute,
} from "../../__fixtures__/fake-playwright.js";
import { type AnyWirePlugin, named } from "../../entities/plugin/index.js";
import { createStage } from "../../widgets/stage/index.js";
import { rest, text } from "../rest/index.js";
import { type WebSocketOptions, websocket } from "./index.js";

const stages: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const stage of stages.splice(0)) await stage.dispose();
});

async function setup(options: WebSocketOptions = {}) {
	const stage = createStage({ plugins: [websocket(options)] });
	stages.push(stage);
	const context = createFakeContext();
	await stage.attach(context);
	const open = async (path = "/live") =>
		(await context.openWebSocket(`ws://app.test${path}`)) as FakeWebSocketRoute;
	return { stage, context, open };
}

/** `kind direction source` of each frame, plus its event or reason. */
const shape = (frames: readonly import("../../index.js").Frame[]) =>
	frames.map((f) =>
		[f.kind, f.direction, f.source, f.meta["event"] ?? f.meta["reason"]]
			.filter((part) => part !== undefined)
			.join(" "),
	);

describe("websocket mock", () => {
	it("plays the server: receives, sends text, bytes and JSON", async () => {
		const { stage, open } = await setup();
		const onConnect = vi.fn((connection: { send(data: string): void }) =>
			connection.send("welcome"),
		);
		const mock = await stage.websocket.mock("/live", { onConnect });
		const route = await open();
		const connection = await mock.next();
		expect(onConnect).toHaveBeenCalledWith(connection);
		expect(connection.url).toBe("ws://app.test/live");
		route.receive("from page");
		route.receive(Buffer.from([1, 2]));
		expect(connection.messages.map((m) => m.text())).toEqual([
			"from page",
			"\u0001\u0002",
		]);
		await expect(connection.nextMessage()).resolves.toMatchObject({
			direction: "out",
			data: "from page",
		});
		route.receive('{"a":1}');
		expect(connection.messages[2]?.json()).toEqual({ a: 1 });
		route.receive(Buffer.from('{"binary":true}'));
		expect(connection.messages[3]?.json()).toEqual({ binary: true });
		connection.send(new Uint8Array([3]));
		connection.send({ hello: true });
		mock.broadcast("everyone");
		expect(route.sent).toEqual([
			"welcome",
			Buffer.from([3]),
			'{"hello":true}',
			"everyone",
		]);
		expect(mock.connections).toEqual([connection]);
		expect(mock.hits).toBe(1);
		// The page's messages are the page's, the stub's are the stub's; the
		// endpoint is the path, as for every HTTP frame.
		const frames = await stage.websocket.frames({ endpoint: "/live" });
		expect(shape(frames)).toEqual([
			"lifecycle none page open",
			"message in stub",
			"message out page",
			"message out page",
			"message out page",
			"message out page",
			"message in stub",
			"message in stub",
			"message in stub",
		]);
		expect(frames[0]?.meta).toEqual({
			event: "open",
			url: "ws://app.test/live",
		});
		expect((await stage.websocket.frames()).length).toBe(frames.length);
	});

	it("sends every binary form as bytes, never as JSON text", async () => {
		const { stage, open } = await setup();
		const mock = await stage.websocket.mock("/live");
		const route = await open();
		const connection = await mock.next();
		connection.send(new Uint8Array([1, 2]).buffer);
		connection.send(new Float32Array([1.5]));
		connection.send(new DataView(new Uint8Array([9]).buffer));
		expect(route.sent).toEqual([
			Buffer.from([1, 2]),
			Buffer.from(new Float32Array([1.5]).buffer),
			Buffer.from([9]),
		]);
	});

	it("completes a close the page starts, so the page's socket does not hang", async () => {
		const { stage, open } = await setup();
		const mock = await stage.websocket.mock("/live");
		const route = await open();
		const connection = await mock.next();
		route.closeFromPeer(1000, "done");
		await expect(connection.closed).resolves.toEqual({
			code: 1000,
			reason: "done",
		});
		// With a handler set, Playwright leaves completing the close to it:
		// without the route closing the page's end, the socket would stay in
		// CLOSING and the page would never get its `close` event.
		expect(route.state).toBe("closed");
		expect(route.closedWith).toEqual([{ code: 1000, reason: "done" }]);
		// Completing it is reported to the handler a second time; one frame.
		expect(
			shape(await stage.websocket.frames()).filter((f) => f.endsWith("close")),
		).toEqual(["lifecycle none page close"]);

		// A close with no code, as `socket.close()` sends it.
		const bare = await open();
		const second = await mock.next();
		bare.closeFromPeer();
		await expect(second.closed).resolves.toEqual({
			code: undefined,
			reason: undefined,
		});
		expect(bare.state).toBe("closed");
	});

	it("closes from the stub once, and says who closed", async () => {
		const { stage, open } = await setup();
		const mock = await stage.websocket.mock("/live");
		const route = await open();
		const connection = await mock.next();
		await connection.close({ code: 4000, reason: "maintenance" });
		await expect(connection.closed).resolves.toEqual({
			code: 4000,
			reason: "maintenance",
		});
		expect(route.closedWith).toEqual([{ code: 4000, reason: "maintenance" }]);
		const closes = (await stage.websocket.frames()).filter(
			(f) => f.meta["event"] === "close",
		);
		// One close frame, the stub's: not a second one for the page hearing of it.
		expect(shape(closes)).toEqual(["lifecycle none stub close"]);
		// A server may close with any code — "going away", say — and so may
		// the stub: the page's end takes it as given.
		const another = await open();
		const second = await mock.next();
		await second.close({ code: 1001, reason: "restarting" });
		expect(another.closedWith).toEqual([{ code: 1001, reason: "restarting" }]);
		await expect(second.closed).resolves.toEqual({
			code: 1001,
			reason: "restarting",
		});
	});

	it("refuses to send once the connection is over, and broadcasts to the rest", async () => {
		const { stage, open } = await setup();
		const mock = await stage.websocket.mock("/live");
		const [left, stays, leaving] = [await open(), await open(), await open()];
		const [gone, , closing] = [
			await mock.next(),
			await mock.next(),
			await mock.next(),
		];
		left.closeFromPeer(1000, "bye");
		await gone.closed;
		// Playwright would drop it without a word, and the timeline would
		// show a message the page never got.
		expect(() => gone.send("late")).toThrow(
			expect.objectContaining({ code: "CLOSED" }),
		);
		// Over from the moment the stub closes it, before the page hears:
		// Playwright reports the close back later, the fake at once unless
		// held.
		vi.spyOn(leaving, "close").mockResolvedValue(undefined);
		await closing.close();
		expect(() => closing.send("late")).toThrow(
			expect.objectContaining({ code: "CLOSED" }),
		);
		mock.broadcast("everyone");
		expect([left.sent, stays.sent, leaving.sent]).toEqual([
			[],
			["everyone"],
			[],
		]);
		expect(
			shape(await stage.websocket.frames()).filter((f) =>
				f.startsWith("message"),
			),
		).toEqual(["message in stub"]);
	});

	it("closes the socket when onConnect throws, and records why", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const { stage, open } = await setup();
		const mock = await stage.websocket.mock("/live", {
			onConnect: async (connection) => {
				connection.send("welcome");
				await Promise.resolve();
				throw new Error("greeting failed");
			},
		});
		const route = await open();
		const connection = await mock.next();
		const reason = 'wirestage: rule "mock /live" failed: greeting failed';
		expect(route.closedWith).toEqual([{ code: 1011, reason }]);
		await expect(connection.closed).resolves.toEqual({ code: 1011, reason });
		// The stage closed it for the stub: the close is the stub's, and
		// nothing more can be sent.
		expect(shape(await stage.websocket.frames())).toEqual([
			"lifecycle none page open",
			"message in stub",
			"fault none stub rule-error",
			"lifecycle none stub close",
		]);
		expect(() => connection.send("late")).toThrow(
			expect.objectContaining({ code: "CLOSED" }),
		);
		expect(logged).toHaveBeenCalled();
	});

	it("lets the newest live rule win, takes `times` connections, and passes removed ones through", async () => {
		const { stage, context, open } = await setup();
		const older = await stage.websocket.mock("/live");
		const newer = await stage.websocket.mock("/live", { times: 1 });
		await open();
		expect(newer.connections).toHaveLength(1);
		expect(older.connections).toHaveLength(0);
		// The newer one took its one connection; the older one is next.
		await open();
		expect(older.connections).toHaveLength(1);
		await newer.remove();
		await older.remove();
		// No live rule matches: the predicate declines and the socket is real.
		expect(await context.openWebSocket("ws://app.test/live")).toBeUndefined();
	});
});

describe("websocket proxy", () => {
	it("forwards both ways, records who said what, drops and injects", async () => {
		const { stage, open } = await setup();
		const proxy = await stage.websocket.proxy("/feed", {
			drop: (message) => message.text() === "drop me",
		});
		const page = await open("/feed");
		const server = page.server as FakeWebSocketRoute;
		const connection = await proxy.next();
		page.receive("up");
		server.receive("down");
		server.receive("drop me");
		expect(server.sent).toEqual(["up"]);
		expect(page.sent).toEqual(["down"]);
		connection.toPage({ injected: 1 });
		connection.toServer(new Uint8Array([9]));
		expect(page.sent.at(-1)).toBe('{"injected":1}');
		expect(server.sent.at(-1)).toEqual(Buffer.from([9]));
		expect(connection.messages.map((m) => m.direction)).toEqual([
			"out",
			"in",
			"in",
		]);
		await expect(connection.nextMessage()).resolves.toMatchObject({
			data: "up",
		});
		expect(shape(await stage.websocket.frames())).toEqual([
			"lifecycle none page open",
			"message out page",
			"message in network",
			"fault in stub dropped",
			"message in test",
			"message out test",
		]);
		expect(proxy.connections).toEqual([connection]);
		expect(proxy.hits).toBe(1);
	});

	it("passes on a close from either end, once, and says who closed", async () => {
		const { stage, open } = await setup();
		const proxy = await stage.websocket.proxy("/feed");

		// The page closes: the server's end is closed too, and the page's own
		// close is completed — its socket would hang in CLOSING otherwise.
		const first = await open("/feed");
		first.closeFromPeer(4001, "page left");
		expect(first.server?.closedWith).toEqual([
			{ code: 4001, reason: "page left" },
		]);
		expect(first.state).toBe("closed");
		await expect((await proxy.next()).closed).resolves.toEqual({
			code: 4001,
			reason: "page left",
		});

		// The server goes away with a code a script may not send: the page
		// sees that very code.
		const second = await open("/feed");
		second.server?.closeFromPeer(1006, "abnormal");
		expect(second.closedWith).toEqual([{ code: 1006, reason: "abnormal" }]);
		expect(second.state).toBe("closed");

		// A close the test starts closes both ends, and is the test's. The
		// server's end is closed by the browser, which refuses such a code —
		// so it goes as a normal closure, rather than staying open.
		const third = await open("/feed");
		await proxy.next();
		const connection = await proxy.next();
		await connection.close({ code: 1011, reason: "fault" });
		expect(third.closedWith).toEqual([{ code: 1011, reason: "fault" }]);
		expect(third.server?.refusedCloses).toEqual([]);
		expect(third.server?.closedWith).toEqual([{ code: 1000, reason: "fault" }]);

		// A close with neither code nor reason, as `socket.close()` sends it.
		const fourth = await open("/feed");
		fourth.closeFromPeer();
		expect(fourth.closedWith).toEqual([{}]);
		expect(fourth.server?.closedWith).toEqual([{}]);

		const closes = (await stage.websocket.frames()).filter(
			(f) => f.meta["event"] === "close",
		);
		// One close per connection, however often the browser reports it.
		expect(closes.map((f) => [f.source, f.meta["code"]])).toEqual([
			["page", 4001],
			["network", 1006],
			["test", 1011],
			["page", undefined],
		]);
	});

	it("closes the connection when drop throws, and says the stub closed it", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const { stage, open } = await setup();
		const proxy = await stage.websocket.proxy("/feed", {
			drop: () => {
				throw new Error("bug in drop");
			},
		});
		const page = await open("/feed");
		const connection = await proxy.next();
		// Called from Playwright's own event dispatch: thrown there, it
		// would be an uncaught exception in the test process.
		expect(() => page.receive("first")).not.toThrow();
		const reason = 'wirestage: rule "proxy /feed" failed: bug in drop';
		expect(page.closedWith).toEqual([{ code: 1011, reason }]);
		expect(page.server?.closedWith).toEqual([{ code: 1000, reason }]);
		await expect(connection.closed).resolves.toEqual({ code: 1011, reason });
		expect(shape(await stage.websocket.frames())).toEqual([
			"lifecycle none page open",
			"fault none stub rule-error",
			"lifecycle none stub close",
		]);
		expect(() => connection.toServer("late")).toThrow(
			expect.objectContaining({ code: "CLOSED" }),
		);
		expect(logged).toHaveBeenCalled();
	});

	it("refuses to inject once the connection is over, from either end", async () => {
		const { stage, open } = await setup();
		const proxy = await stage.websocket.proxy("/feed");
		const first = await open("/feed");
		const closedByServer = await proxy.next();
		first.server?.closeFromPeer(4002, "server is done");
		await closedByServer.closed;
		const second = await open("/feed");
		const closedByTest = await proxy.next();
		// Over from the moment the test closes it, before either end reports
		// the close back — which the fake does at once unless held.
		vi.spyOn(second, "close").mockResolvedValue(undefined);
		vi.spyOn(second.server as FakeWebSocketRoute, "close").mockResolvedValue(
			undefined,
		);
		await closedByTest.close();
		for (const connection of [closedByServer, closedByTest]) {
			expect(() => connection.toPage("late")).toThrow(
				expect.objectContaining({ code: "CLOSED" }),
			);
			expect(() => connection.toServer("late")).toThrow(
				expect.objectContaining({ code: "CLOSED" }),
			);
		}
		expect([
			first.sent,
			first.server?.sent,
			second.sent,
			second.server?.sent,
		]).toEqual([[], [], [], []]);
		expect(
			(await stage.websocket.frames()).filter((f) => f.kind === "message"),
		).toEqual([]);
	});

	it("stops proxying new connections once removed, or after `times`", async () => {
		const { stage, context, open } = await setup();
		const once = await stage.websocket.proxy("/feed", { times: 1 });
		await open("/feed");
		expect(await context.openWebSocket("ws://app.test/feed")).toBeUndefined();
		expect(once.hits).toBe(1);
		const proxy = await stage.websocket.proxy("/feed");
		await proxy.remove();
		expect(await context.openWebSocket("ws://app.test/feed")).toBeUndefined();
	});
});

describe("websocket plugin", () => {
	it("routes from attach, so a mock added later reaches an open page", async () => {
		const stage = createStage({ plugins: [websocket()] });
		stages.push(stage);
		const context = createFakeContext();
		const routeWebSocket = vi.spyOn(context, "routeWebSocket");
		await stage.attach(context);
		expect(routeWebSocket).toHaveBeenCalledTimes(1);
		await stage.websocket.mock("/live");
		expect(routeWebSocket).toHaveBeenCalledTimes(1);
	});

	it("leaves the page's WebSocket alone until the first rule when lazy", async () => {
		const stage = createStage({ plugins: [websocket({ lazy: true })] });
		stages.push(stage);
		const context = createFakeContext();
		const routeWebSocket = vi.spyOn(context, "routeWebSocket");
		await stage.attach(context);
		expect(routeWebSocket).not.toHaveBeenCalled();
		await stage.websocket.mock("/live");
		expect(routeWebSocket).toHaveBeenCalledTimes(1);
	});

	it("stops with the stage: a disposed stage mocks nothing", async () => {
		const { stage, context, open } = await setup();
		const mock = await stage.websocket.mock("/live");
		await open();
		await stage.dispose();
		// The context lives on; its sockets are the real server's again.
		expect(await context.openWebSocket("ws://app.test/live")).toBeUndefined();
		expect(mock.connections).toHaveLength(1);
	});

	it("records under the name it is given", async () => {
		const stage = createStage({ plugins: [named("chat", websocket())] });
		stages.push(stage);
		const context = createFakeContext();
		await stage.attach(context);
		await stage.chat.mock("/live");
		await context.openWebSocket("ws://app.test/live");
		expect((await stage.chat.frames()).map((f) => f.protocol)).toEqual([
			"chat",
		]);
	});
});

/** A client outside the browser: Node's own WebSocket. */
function client(url: string, protocols?: string[]) {
	const socket = new WebSocket(url, protocols);
	socket.binaryType = "arraybuffer";
	const received: (string | Uint8Array)[] = [];
	socket.addEventListener("message", (event) =>
		received.push(
			typeof event.data === "string"
				? event.data
				: new Uint8Array(event.data as ArrayBuffer),
		),
	);
	const opened = new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () =>
			reject(new Error(`no WebSocket to ${url}`)),
		);
	});
	// Its own catch: a refused handshake is what some tests are about.
	opened.catch(() => undefined);
	const closed = new Promise<{ code: number; reason: string }>((resolve) =>
		socket.addEventListener("close", (event) =>
			resolve({ code: event.code, reason: event.reason }),
		),
	);
	return { socket, received, opened, closed };
}

/** Until `check` holds: what a socket does arrives on its own time. */
async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 400 && !check(); i++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
}

describe("served WebSockets", () => {
	const serving = <const Plugins extends readonly AnyWirePlugin[]>(
		plugins: Plugins,
	) => {
		const stage = createStage({ plugins });
		stages.push(stage);
		return stage;
	};

	it("plays the server for a client outside the browser, on the timeline", async () => {
		const stage = serving([websocket()]);
		const server = await stage.websocket.serve({ name: "fake feed" });
		expect(server.url).toBe(`ws://127.0.0.1:${server.port}`);
		const feed = await server.mock("/feed", {
			onConnect: (connection) => connection.send("welcome"),
		});
		const peer = client(`${server.url}/feed?since=1`, ["v1", "v0"]);
		await peer.opened;
		expect(peer.socket.protocol).toBe("v1");
		const connection = await feed.next();
		expect(connection.url).toBe(`${server.url}/feed?since=1`);
		expect(connection.open).toBe(true);
		await until(() => peer.received.length === 1);
		peer.socket.send("hi");
		await expect(connection.nextMessage()).resolves.toMatchObject({
			direction: "out",
			data: "hi",
		});
		expect(connection.messages.map((message) => message.text())).toEqual([
			"hi",
		]);
		connection.send({ n: 1 });
		connection.send(new Uint8Array([7]));
		expect(feed.broadcast("all")).toBe(1);
		await until(() => peer.received.length === 4);
		expect(peer.received).toEqual([
			"welcome",
			'{"n":1}',
			new Uint8Array([7]),
			"all",
		]);
		peer.socket.close(4000, "bye");
		await expect(connection.closed).resolves.toEqual({
			code: 4000,
			reason: "bye",
		});
		expect(connection.open).toBe(false);
		expect(() => connection.send("late")).toThrow(
			expect.objectContaining({ code: "CLOSED" }),
		);
		expect(feed.broadcast("nobody")).toBe(0);
		const frames = await server.frames();
		expect(shape(frames)).toEqual([
			"lifecycle none network open",
			"message in server",
			"message out network",
			"message in server",
			"message in server",
			"message in server",
			"lifecycle none network close",
		]);
		expect(frames[0]?.meta).toMatchObject({
			url: `${server.url}/feed?since=1`,
			protocol: "v1",
			server: server.url,
		});
		expect(frames[0]?.meta["headers"]).toMatchObject({
			"sec-websocket-protocol": "v1, v0",
		});
		expect(
			frames.every(
				(frame) =>
					frame.endpoint === "/feed" &&
					frame.correlation === frames[0]?.correlation,
			),
		).toBe(true);
		expect(await stage.websocket.frames({ endpoint: "/feed" })).toEqual(frames);
		expect(await server.frames({ endpoint: "/other" })).toEqual([]);
	});

	it("refuses a handshake no rule takes; the newest rule takes the rest", async () => {
		const stage = serving([websocket()]);
		const server = await stage.websocket.serve();
		const any = await server.mock("/**");
		const once = await server.mock("/feed", { times: 1 });
		await client(`${server.url}/feed`).opened;
		await client(`${server.url}/feed`).opened;
		expect([once.hits, any.hits]).toEqual([1, 1]);
		await any.remove();
		await any.remove();
		const refused = client(`${server.url}/feed`);
		await expect(refused.opened).rejects.toThrow();
		expect((await refused.closed).code).toBe(1006);
		const frames = await server.frames();
		expect(frames.at(-1)?.meta).toMatchObject({
			reason: "unmatched",
			status: 404,
			url: `${server.url}/feed`,
		});
		await expect(server.mock("/x", { times: 0 })).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
			message: 'rule "mock /x": times must be a positive integer, got 0',
		});
	});

	it("cuts, closes and fails connections, each on record", async () => {
		const stage = serving([websocket()]);
		const server = await stage.websocket.serve();
		const failing = await server.mock("/bad", {
			onConnect: () => {
				throw new Error("boom");
			},
		});
		const feed = await server.mock("/feed");
		const cut = client(`${server.url}/feed`);
		await cut.opened;
		const first = await feed.next();
		first.cut();
		first.cut();
		expect(first.open).toBe(false);
		await expect(cut.closed).resolves.toMatchObject({ code: 1006 });
		await expect(first.closed).resolves.toEqual({ code: 1006, reason: "" });
		const closed = client(`${server.url}/feed`);
		await closed.opened;
		const second = await feed.next();
		await second.close({ code: 4001, reason: "done" });
		await expect(closed.closed).resolves.toEqual({
			code: 4001,
			reason: "done",
		});
		second.cut();
		const bad = client(`${server.url}/bad`);
		await expect(bad.closed).resolves.toEqual({
			code: 1011,
			reason: 'wirestage: rule "mock /bad" failed: boom',
		});
		expect(failing.hits).toBe(1);
		// The server's end is over a moment after the client's.
		await failing.connections[0]?.closed;
		expect(shape(await server.frames())).toEqual([
			"lifecycle none network open",
			"fault none server cut",
			"lifecycle none network open",
			"lifecycle none server close",
			"lifecycle none network open",
			"fault none server rule-error",
			"lifecycle none server close",
		]);
		await expect(second.close({ code: 1005 })).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
	});

	it("shares a port with a REST fake, as one backend", async () => {
		const stage = serving([rest(), websocket()]);
		const api = await stage.rest.serve({ name: "fake logs" });
		await api.get("/range", text("lines"));
		const tail = await stage.websocket.serve({
			port: api.port,
			name: "fake logs",
		});
		await tail.mock("/tail", {
			onConnect: (connection) => connection.send("line"),
		});
		expect(tail.port).toBe(api.port);
		expect(await (await fetch(`${api.url}/range`)).text()).toBe("lines");
		const peer = client(`${tail.url}/tail`);
		await until(() => peer.received.length === 1);
		await tail.close();
		await expect(peer.closed).resolves.toMatchObject({ code: 1006 });
		// The REST half is still there.
		expect(await (await fetch(`${api.url}/range`)).text()).toBe("lines");
		await expect(
			stage.rest.serve({ port: api.port, name: "second api" }),
		).rejects.toMatchObject({ code: "INVALID_STATE" });
	});

	it("closes with the stage, cutting what is still open", async () => {
		const stage = serving([websocket()]);
		const server = await stage.websocket.serve({ host: "127.0.0.1" });
		await server.mock("/**");
		const peer = client(`${server.url}/live`);
		await peer.opened;
		await stage.dispose();
		await expect(peer.closed).resolves.toMatchObject({ code: 1006 });
		expect(server.close()).toBe(server.close());
		await expect(client(`${server.url}/live`).opened).rejects.toThrow();
	});
});
