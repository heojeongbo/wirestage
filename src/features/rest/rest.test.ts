import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFakeContext,
	fakeResponse,
} from "../../__fixtures__/fake-playwright.js";
import { named } from "../../entities/plugin/index.js";
import { createManualClock } from "../../shared/lib/clock/index.js";
import { createStage } from "../../widgets/stage/index.js";
import {
	abort,
	bytes,
	delay,
	empty,
	json,
	passthrough,
	rest,
	text,
} from "./index.js";
import { compilePath } from "./lib/path.js";

const stages: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
	for (const stage of stages.splice(0)) await stage.dispose();
});

async function setup(
	options: Parameters<typeof rest>[0] = {},
	clock = createManualClock(),
) {
	const stage = createStage({ plugins: [rest(options)], clock });
	stages.push(stage);
	const context = createFakeContext();
	await stage.attach(context);
	return { stage, context, clock };
}

describe("reply helpers", () => {
	it("builds responses with sensible defaults", () => {
		expect(json({ n: 1n }, { status: 201, headers: { a: "b" } })).toEqual({
			kind: "response",
			status: 201,
			headers: { "content-type": "application/json", a: "b" },
			body: '{"n":"1"}',
		});
		expect(text("hi")).toMatchObject({
			status: 200,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
		expect(bytes(new Uint8Array([1]))).toMatchObject({
			headers: { "content-type": "application/octet-stream" },
		});
		expect(
			bytes(new Uint8Array([1]), { contentType: "image/png" }),
		).toMatchObject({
			headers: { "content-type": "image/png" },
		});
		expect(empty()).toEqual({ kind: "response", status: 204, headers: {} });
		expect(empty({ status: 202 })).toMatchObject({ status: 202 });
		expect(passthrough()).toEqual({ kind: "passthrough" });
		expect(abort()).toEqual({ kind: "abort", error: "failed" });
		expect(abort("timedout")).toEqual({ kind: "abort", error: "timedout" });
		expect(delay(5, empty())).toEqual({ kind: "delay", ms: 5, reply: empty() });
	});
});

describe("path patterns", () => {
	const url = (href: string) => new URL(href);

	it("extracts decoded params and ignores the query and a trailing slash", () => {
		const path = compilePath("/rooms/:id/files/**", undefined);
		expect(path.match(url("http://h/rooms/r%201/files/a/b?x=1"))).toEqual({
			id: "r 1",
		});
		// `*` is one segment and `**` any number, as in every other pattern.
		const one = compilePath("/rooms/:id/files/*", undefined);
		expect(one.match(url("http://h/rooms/r1/files/a"))).toEqual({ id: "r1" });
		expect(one.match(url("http://h/rooms/r1/files/a/b"))).toBeUndefined();
		// A malformed escape is kept as it came, not thrown at every request.
		expect(
			compilePath("/items/:id", undefined).match(
				url("http://h/items/%E0%A4%A"),
			),
		).toEqual({ id: "%E0%A4%A" });
		expect(
			compilePath("/items/:id", undefined).match(url("http://h/items/7/")),
		).toEqual({ id: "7" });
		expect(
			compilePath("/items/:id", undefined).match(url("http://h/items")),
		).toBeUndefined();
		// Specials are literal.
		expect(
			compilePath("/a.b", undefined).match(url("http://h/axb")),
		).toBeUndefined();
	});

	it("joins a base path, and matches absolute patterns with the origin", () => {
		expect(
			compilePath("items", "/api/v1/").match(url("http://h/api/v1/items")),
		).toEqual({});
		expect(
			compilePath("/items", "https://api.test").match(
				url("https://api.test/items"),
			),
		).toEqual({});
		expect(
			compilePath("/items", "https://api.test").match(
				url("https://other.test/items"),
			),
		).toBeUndefined();
		expect(
			compilePath("http://h:8080/x", "/ignored").match(url("http://h:8080/x")),
		).toEqual({});
	});

	it("refuses a route that names a query, which could never match", () => {
		expect(() => compilePath("/search?q=1", undefined)).toThrow(
			expect.objectContaining({
				code: "INVALID_ARGUMENT",
				message: expect.stringContaining("matches the path alone"),
			}),
		);
	});

	it("uses a RegExp's named groups as params", () => {
		const path = compilePath(/^\/users\/(?<id>\d+)$/g, undefined);
		expect(path.match(url("http://h/users/3"))).toEqual({ id: "3" });
		expect(path.match(url("http://h/users/3"))).toEqual({ id: "3" });
		expect(
			compilePath(/^\/plain$/, undefined).match(url("http://h/plain")),
		).toEqual({});
		expect(path.match(url("http://h/users/x"))).toBeUndefined();
	});
});

describe("rest plugin", () => {
	it("answers each verb with values or functions of the request", async () => {
		const { stage, context } = await setup({ baseURL: "/api" });
		const room = await stage.rest.get("/rooms/:id", (request) =>
			json({
				id: request.params["id"],
				q: request.query.get("q"),
				page: request.page,
			}),
		);
		await stage.rest.post("/rooms", async (request) =>
			json(request.json(), { status: 201 }),
		);
		await stage.rest.put("/rooms/:id", empty());
		await stage.rest.patch("/rooms/:id", text("patched"));
		await stage.rest.delete("/rooms/:id", empty({ status: 202 }));
		await stage.rest.on("*", "/any", text("any"));
		const send = async (method: string, path: string, body?: string) => {
			const { outcome } = await context.dispatch(`http://app.test${path}`, {
				method,
				...(body === undefined ? {} : { body }),
			});
			return outcome.kind === "fulfill"
				? [outcome.status, outcome.body.toString()]
				: [outcome.kind];
		};
		expect(await send("GET", "/api/rooms/r1?q=z")).toEqual([
			200,
			'{"id":"r1","q":"z"}',
		]);
		expect(await send("POST", "/api/rooms", '{"a":1}')).toEqual([
			201,
			'{"a":1}',
		]);
		expect(await send("PUT", "/api/rooms/r1")).toEqual([204, ""]);
		expect(await send("PATCH", "/api/rooms/r1")).toEqual([200, "patched"]);
		expect(await send("DELETE", "/api/rooms/r1")).toEqual([202, ""]);
		expect(await send("OPTIONS", "/api/any")).toEqual([200, "any"]);
		expect(await send("GET", "/api/missing")).toEqual(["network"]);
		expect(room.hits).toBe(1);
		expect(room.requests[0]?.params).toEqual({ id: "r1" });
		await expect(room.next()).resolves.toMatchObject({ method: "GET" });
		// A request is a plain object: it spreads and prints whole.
		const [request] = room.requests;
		expect({ ...request }).toMatchObject({
			method: "GET",
			params: { id: "r1" },
			context: "c1",
		});
		expect(JSON.parse(JSON.stringify(request))).toMatchObject({
			method: "GET",
			url: "http://app.test/api/rooms/r1?q=z",
			correlation: expect.stringMatching(/^x\d+$/),
		});
	});

	it("passes through, aborts, delays, and limits by times and match", async () => {
		const clock = createManualClock();
		const { stage, context } = await setup({}, clock);
		await stage.rest.get("/pass", passthrough());
		await stage.rest.get("/drop", abort("connectionreset"));
		await stage.rest.get("/slow", delay(100, text("finally")));
		const once = await stage.rest.get("/once", text("first"), { times: 1 });
		await stage.rest.get("/vip", text("vip"), {
			match: (request) => request.headers["x-vip"] === "1",
		});
		expect((await context.dispatch("http://h/pass")).outcome.kind).toBe(
			"network",
		);
		expect((await context.dispatch("http://h/drop")).outcome).toEqual({
			kind: "abort",
			error: "connectionreset",
		});
		const slow = context.dispatch("http://h/slow");
		await vi.waitFor(() => expect(clock.pending).toBe(1));
		await clock.advance(100);
		expect((await slow).outcome.kind).toBe("fulfill");
		expect((await context.dispatch("http://h/once")).outcome.kind).toBe(
			"fulfill",
		);
		expect((await context.dispatch("http://h/once")).outcome.kind).toBe(
			"network",
		);
		expect(once.hits).toBe(1);
		expect((await context.dispatch("http://h/vip")).outcome.kind).toBe(
			"network",
		);
		expect(
			(await context.dispatch("http://h/vip", { headers: { "x-vip": "1" } }))
				.outcome.kind,
		).toBe("fulfill");
		const removable = await stage.rest.get("/gone", text("x"));
		await removable.remove();
		expect((await context.dispatch("http://h/gone")).outcome.kind).toBe(
			"network",
		);
	});

	it("lists recorded exchanges with their status, filtered", async () => {
		const { stage, context } = await setup({ baseURL: "/api" });
		await stage.rest.get("/a", json({}));
		await stage.rest.post("/b", abort());
		await stage.rest.get("/c", passthrough());
		await context.dispatch("http://h/api/a");
		await context.dispatch("http://h/api/b", { method: "POST" });
		await context.dispatch("http://h/api/c");
		const calls = await stage.rest.calls();
		expect(
			calls.map((c) => [
				c.method,
				new URL(c.url).pathname,
				c.status,
				c.response?.kind,
			]),
		).toEqual([
			["GET", "/api/a", 200, "response"],
			["POST", "/api/b", undefined, undefined],
			["GET", "/api/c", undefined, undefined],
		]);
		expect((await stage.rest.calls({ method: "post" })).length).toBe(1);
		expect((await stage.rest.calls({ path: "/a" })).length).toBe(1);
		// A frame without its request (cleared timeline) is skipped, not crashed on.
		stage.timeline.append({
			protocol: "rest",
			kind: "response",
			direction: "in",
			endpoint: "/x",
			source: "network",
		});
		expect((await stage.rest.calls()).length).toBe(3);
	});

	it("records passthrough traffic under the base URL, each request once", async () => {
		const { stage, context } = await setup({ baseURL: "/api", record: true });
		const second = createFakeContext();
		await stage.attach(second);
		await stage.rest.get("/stubbed", text("stub"));
		const { request } = await context.dispatch("http://h/api/real");
		request.responseValue = fakeResponse(200, {}, "from the server");
		context.emit("requestfinished", request);
		expect((await context.dispatch("http://h/api/stubbed")).outcome.kind).toBe(
			"fulfill",
		);
		expect((await context.dispatch("http://h/outside")).outcome.kind).toBe(
			"network",
		);
		const calls = await stage.rest.calls();
		expect(
			calls.map((c) => [new URL(c.url).pathname, c.status, c.response?.source]),
		).toEqual([
			["/api/real", 200, "network"],
			// Recorded by the route that answered it, not again by the recorder.
			["/api/stubbed", 200, "stub"],
		]);
	});

	it("makes one call of a request a watching route passed on", async () => {
		const { stage, context } = await setup({ baseURL: "/api", record: true });
		await stage.rest.get("/rooms/:id", json({ from: "the suite's stub" }));
		// Newer, so it sees the request first, and answers nothing.
		const watching = await stage.rest.get("/rooms/r1", passthrough());
		const { outcome } = await context.dispatch("http://h/api/rooms/r1");
		expect(outcome.kind === "fulfill" && outcome.body.toString()).toBe(
			'{"from":"the suite\'s stub"}',
		);
		expect(watching.hits).toBe(1);
		const calls = await stage.rest.calls();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ status: 200 });
		// A stub answered: nothing came from the network.
		expect(calls[0]?.response?.source).toBe("stub");

		// And with no stub under it, the real server's answer closes the call.
		const { request } = await context.dispatch("http://h/api/legacy/report");
		request.responseValue = fakeResponse(200, {}, "real");
		context.emit("requestfinished", request);
		const all = await stage.rest.calls({ path: "/legacy/**" });
		expect(all.map((c) => [c.status, c.response?.source])).toEqual([
			[200, "network"],
		]);
	});

	it("runs twice under two names, each with its own routes and calls", async () => {
		const stage = createStage({
			plugins: [
				rest({ baseURL: "/api" }),
				named("billing", rest({ baseURL: "https://billing.test" })),
			],
		});
		stages.push(stage);
		const context = createFakeContext();
		await stage.attach(context);
		await stage.rest.get("/me", json({ app: true }));
		await stage.billing.get("/invoices", json([]));
		await context.dispatch("http://app.test/api/me");
		await context.dispatch("https://billing.test/invoices");
		expect((await stage.rest.calls()).map((c) => c.url)).toEqual([
			"http://app.test/api/me",
		]);
		expect((await stage.billing.calls()).map((c) => c.url)).toEqual([
			"https://billing.test/invoices",
		]);
		expect((await stage.frames({ protocol: "billing" })).length).toBe(2);
	});

	it("records with a custom matcher, and not at all when told no", async () => {
		const matcher = await setup({ record: "**/only/**" });
		await matcher.context.dispatch("http://h/only/x");
		await matcher.context.dispatch("http://h/not");
		expect((await matcher.stage.rest.calls()).length).toBe(1);
		const off = await setup({ record: false });
		await off.context.dispatch("http://h/anything");
		expect((await off.stage.rest.calls()).length).toBe(0);
		const everything = await setup({ record: true });
		await everything.context.dispatch("http://h/anything");
		expect((await everything.stage.rest.calls()).length).toBe(1);
	});
});
