import { ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeContext } from "../../__fixtures__/fake-playwright.js";
import { named } from "../../entities/plugin/index.js";
import { createStage } from "../../widgets/stage/index.js";
import { encodeSseEvent, sse } from "./index.js";

const stages: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const stage of stages.splice(0)) await stage.dispose();
});

async function setup() {
	const stage = createStage({ plugins: [sse()] });
	stages.push(stage);
	const context = createFakeContext();
	await stage.attach(context);
	return { stage, context, fetch: context.fetch() };
}

/** Read an event-stream response until `count` events have arrived. */
async function readEvents(
	response: Response,
	count: number,
): Promise<string[]> {
	const reader =
		response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
	const decoder = new TextDecoder();
	let buffer = "";
	while (buffer.split("\n\n").length - 1 < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value);
	}
	return buffer.split("\n\n").filter((e) => e.length > 0);
}

describe("sse encoding", () => {
	it("encodes every field, splitting multi-line data and comments", () => {
		expect(encodeSseEvent("plain")).toBe("data: plain\n\n");
		expect(encodeSseEvent("two\nlines")).toBe("data: two\ndata: lines\n\n");
		expect(
			encodeSseEvent({
				comment: "keep\nalive",
				event: "tick",
				id: "7",
				retry: 500,
				data: { n: 1 },
			}),
		).toBe(
			': keep\n: alive\nevent: tick\nid: 7\nretry: 500\ndata: {"n":1}\n\n',
		);
		expect(encodeSseEvent({ data: "text" })).toBe("data: text\n\n");
		expect(encodeSseEvent({})).toBe("\n");
	});
});

describe("sse plugin", () => {
	it("streams events to the page as the test sends them", async () => {
		const { stage, fetch } = await setup();
		const stub = await stage.sse.stream("/events", {
			retry: 1000,
			headers: { "x-a": "1" },
		});
		const response = await fetch("http://app.test/events");
		expect(response.headers.get("content-type")).toBe(
			"text/event-stream; charset=utf-8",
		);
		expect(response.headers.get("x-a")).toBe("1");
		const connection = await stub.next();
		expect(connection.lastEventId).toBeUndefined();
		await connection.send({ event: "hello", data: { n: 1 } });
		await connection.send("second");
		const events = await readEvents(response, 3);
		expect(events).toEqual([
			"retry: 1000",
			'event: hello\ndata: {"n":1}',
			"data: second",
		]);
		expect(connection.sent).toBe(2);
		expect(stub.hits).toBe(1);
		expect(stub.connections).toEqual([connection]);
		const frames = await stage.sse.events();
		expect(frames.map((f) => f.value)).toEqual([
			{ event: "hello", data: { n: 1 } },
			"second",
		]);
		expect((await stage.sse.events({ endpoint: "/events" })).length).toBe(2);
		expect(frames[0]?.correlation).toBe(connection.request.correlation);
		await connection.end();
		await connection.end();
		await expect(connection.closed).resolves.toBe("ended");
		await expect(connection.send("late")).rejects.toMatchObject({
			code: "CLOSED",
		});
		// The whole exchange is on the timeline: who asked, what was sent, how
		// it ended.
		await vi.waitFor(async () =>
			expect(
				(await stage.frames({ protocol: "sse" })).map((f) => [
					f.kind,
					f.source,
				]),
			).toEqual([
				["request", "page"],
				["event", "stub"],
				["event", "stub"],
				["lifecycle", "stub"],
			]),
		);
	});

	it("reads the Last-Event-ID a reconnecting client sends", async () => {
		const { stage, fetch } = await setup();
		const stub = await stage.sse.stream("/events");
		const response = await fetch("http://app.test/events", {
			headers: { "last-event-id": "41" },
		});
		expect((await stub.next()).lastEventId).toBe("41");
		expect(response.status).toBe(200);
	});

	it("cuts a connection the way a network drop would", async () => {
		const { stage, fetch } = await setup();
		const stub = await stage.sse.stream("/events", { status: 200 });
		const response = await fetch("http://app.test/events");
		const connection = await stub.next();
		await connection.cut();
		await connection.cut();
		await expect(connection.closed).resolves.toBe("cut");
		await expect(response.text()).rejects.toThrow();
		// A fault the test injected is on the timeline like any other.
		await vi.waitFor(async () =>
			expect(
				(await stage.frames({ protocol: "sse", kind: "fault" })).map(
					(f) => f.meta,
				),
			).toEqual([{ reason: "cut" }]),
		);
	});

	it("says so when a request matched but its stream never arrived", async () => {
		const { stage, context } = await setup();
		const stub = await stage.sse.stream("/events");
		// Nothing asked yet: a plain timeout.
		await expect(stub.next({ timeout: 5 })).rejects.toThrow(
			/^no SSE connection arrived within 5 ms \(0 seen so far\)$/,
		);
		// The stub answered, but the redirect to the stream server is not
		// followed here — a page that cannot reach it looks the same.
		await context.dispatch("http://app.test/events");
		await expect(stub.next({ timeout: 5 })).rejects.toThrow(
			/1 request\(s\) matched but never reached the local stream server/,
		);
	});

	it("records under the name it is given", async () => {
		const stage = createStage({ plugins: [named("feed", sse())] });
		stages.push(stage);
		const context = createFakeContext();
		await stage.attach(context);
		const stub = await stage.feed.stream("/events");
		const response = await context.fetch()("http://app.test/events");
		await (await stub.next()).send("x");
		expect(response.status).toBe(200);
		expect((await stage.feed.events()).map((f) => f.protocol)).toEqual([
			"feed",
		]);
	});

	it("notices when the page closes the stream", async () => {
		const { stage, fetch } = await setup();
		const stub = await stage.sse.stream("/events");
		const abort = new AbortController();
		const response = await fetch("http://app.test/events", {
			signal: abort.signal,
		});
		const connection = await stub.next();
		expect(response.status).toBe(200);
		// What a page navigating away does to its EventSource.
		abort.abort();
		await expect(connection.closed).resolves.toBe("cancelled");
		await connection.end();
	});

	it("broadcasts to every open connection, skipping closed ones", async () => {
		const { stage, fetch } = await setup();
		const stub = await stage.sse.stream("/events");
		const first = await fetch("http://app.test/events");
		const second = await fetch("http://app.test/events");
		const [a, b] = [await stub.next(), await stub.next()];
		await b?.end();
		await stub.broadcast("all");
		expect(await readEvents(first, 1)).toEqual(["data: all"]);
		expect(a?.sent).toBe(1);
		expect(second.status).toBe(200);
		await stub.remove();
		expect((await fetch("http://app.test/events")).status).toBe(502);
	});

	it("limits by times and match", async () => {
		const { stage, fetch } = await setup();
		await stage.sse.stream("/events", {
			times: 1,
			match: (request) => request.headers["x-ok"] === "1",
		});
		expect((await fetch("http://app.test/events")).status).toBe(502);
		expect(
			(await fetch("http://app.test/events", { headers: { "x-ok": "1" } }))
				.status,
		).toBe(200);
		expect(
			(await fetch("http://app.test/events", { headers: { "x-ok": "1" } }))
				.status,
		).toBe(502);
	});

	it("tags events with the page, and rejects a send whose write fails", async () => {
		const { stage, context } = await setup();
		const page = context.newPage();
		const stub = await stage.sse.stream("/events", { retry: 10 });
		const response = await context.fetch({ page })("http://app.test/events");
		const connection = await stub.next();
		expect(connection.request.page).toBe("p1");
		await connection.send("tagged");
		expect((await stage.sse.events())[0]?.page).toBe("p1");
		expect(response.status).toBe(200);
		// The socket went away under a write (EPIPE): the send says so.
		vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
			this: ServerResponse,
			_chunk: unknown,
			callback?: unknown,
		) {
			(callback as (error?: Error) => void)(new Error("EPIPE"));
			return false;
		} as typeof ServerResponse.prototype.write);
		await expect(connection.send("lost")).rejects.toThrow("EPIPE");
		// The retry preamble of a new connection fails the same way, quietly.
		const second = context.fetch()("http://app.test/events");
		await stub.next();
		vi.restoreAllMocks();
		expect((await second).status).toBe(200);
	});
});
