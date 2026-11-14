import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFakeContext,
	createFakeRoute,
	type FakeRequest,
	fakeResponse,
} from "../../../__fixtures__/fake-playwright.js";
import { createTimeline } from "../../../entities/frame/index.js";
import type {
	HttpRequestView,
	HttpRule,
	ResponseStream,
} from "../../../entities/plugin/index.js";
import type {
	RouteHandler,
	RoutePort,
} from "../../../shared/api/playwright/index.js";
import {
	createStreamServer,
	type StreamServer,
} from "../../../shared/api/stream-server/index.js";
import { createManualClock } from "../../../shared/lib/clock/index.js";
import {
	createObjectIds,
	createSequence,
} from "../../../shared/lib/id/index.js";
import { createScopedLogger } from "../../../shared/lib/logger/index.js";
import type { AttachedContext } from "./attached-context.js";
import { createHttpRouter } from "./http-router.js";

const servers: StreamServer[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const server of servers.splice(0)) await server.close();
});

const attachmentOf = (
	id: string,
	context: ReturnType<typeof createFakeContext>,
): AttachedContext => ({ id, context, cookies: context, baseURL: undefined });

/** What the router waits on the browser for, in these tests. */
const TIMEOUT_MS = 1_000;

function setup() {
	const clock = createManualClock();
	const timeline = createTimeline({ clock });
	const log = createScopedLogger("Http");
	const streams = createStreamServer();
	servers.push(streams);
	const router = createHttpRouter({
		timeline,
		log,
		streams,
		pageId: createObjectIds("p"),
		correlation: createSequence("x"),
		clock,
		timeoutMs: TIMEOUT_MS,
	});
	const context = createFakeContext();
	const attachment = attachmentOf("c1", context);
	return { clock, timeline, log, router, context, attachment, streams };
}

const rule = (over: Partial<HttpRule> = {}): HttpRule => ({
	protocol: "http",
	label: "test rule",
	url: "/api/**",
	handle: () => ({ type: "fulfill", body: "ok" }),
	...over,
});

async function attached(over?: Partial<HttpRule>) {
	const harness = setup();
	await harness.router.attach(harness.attachment);
	const handle = await harness.router.add(rule(over));
	return { ...harness, handle };
}

/** The route handler the router installed, to call with a route of the test's own. */
async function captured(over?: Partial<HttpRule>) {
	const harness = setup();
	let handler: RouteHandler | undefined;
	vi.spyOn(harness.context, "route").mockImplementation(async (_p, h) => {
		handler = h;
	});
	await harness.router.attach(harness.attachment);
	const handle = await harness.router.add(rule(over));
	/** Run the handler with answers of the test's own, taken once as Playwright takes them. */
	const run = async (
		route:
			| Partial<Omit<RoutePort, "request">>
			| ((request: FakeRequest) => Partial<Omit<RoutePort, "request">>),
		url = "http://app.test/api/x",
	) => {
		const { request } = await harness.context.dispatch(url);
		await (handler as RouteHandler)(
			createFakeRoute(request, {
				fulfill: vi.fn().mockResolvedValue(undefined),
				continue: vi.fn().mockResolvedValue(undefined),
				fallback: vi.fn().mockResolvedValue(undefined),
				abort: vi.fn().mockResolvedValue(undefined),
				...(typeof route === "function" ? route(request) : route),
			}),
			request,
		);
		return request;
	};
	return { ...harness, handle, run };
}

const kinds = (timeline: ReturnType<typeof setup>["timeline"]) =>
	timeline.frames().map((f) => `${f.kind} ${f.source} ${f.correlation}`);

describe("http router: one rule", () => {
	it("fulfills, recording the request and the stubbed response", async () => {
		const { context, timeline, handle } = await attached({
			handle: (request) => ({
				type: "fulfill",
				status: 201,
				headers: { "x-a": "1" },
				body: `echo ${request.text()} ${request.json<{ n: number }>().n}`,
			}),
		});
		const page = context.newPage();
		const { outcome } = await context.dispatch("http://app.test/api/x", {
			method: "POST",
			body: '{"n":1}',
			page,
		});
		expect(outcome).toMatchObject({
			kind: "fulfill",
			status: 201,
			headers: { "x-a": "1" },
		});
		expect(outcome.kind === "fulfill" && outcome.body.toString()).toBe(
			'echo {"n":1} 1',
		);
		expect(handle.hits).toBe(1);
		const [request, response] = timeline.frames();
		expect(request).toMatchObject({
			protocol: "http",
			kind: "request",
			direction: "out",
			endpoint: "/api/x",
			source: "page",
			page: "p1",
			context: "c1",
			correlation: "x1",
			meta: { method: "POST", url: "http://app.test/api/x" },
		});
		expect(request?.payload.text()).toBe('{"n":1}');
		expect(response).toMatchObject({
			kind: "response",
			source: "stub",
			correlation: "x1",
			meta: { status: 201 },
		});
		// The request a route answered still "finishes" in the browser; that is
		// the stub's response coming back, not a second, network one.
		expect(timeline.size).toBe(2);
	});

	it("fulfills without a body and without recording when told", async () => {
		const { context, timeline } = await attached({
			record: false,
			handle: () => ({ type: "fulfill" }),
		});
		const { outcome } = await context.dispatch("http://app.test/api/x");
		expect(outcome).toMatchObject({ kind: "fulfill", status: 200 });
		expect(timeline.size).toBe(0);
	});

	it("records a fulfilled response without a body", async () => {
		const { context, timeline } = await attached({
			handle: () => ({ type: "fulfill", status: 204 }),
		});
		await context.dispatch("http://app.test/api/x", { frameless: true });
		const response = timeline.last();
		expect(response?.payload.empty).toBe(true);
		// A service-worker request has no page.
		expect(timeline.frames()[0]?.page).toBeUndefined();
		expect(timeline.frames()[0]?.payload.bytes()).toEqual(new Uint8Array(0));
	});

	it("leaves a request alone when its method, match or URL does not fit", async () => {
		const { context, handle } = await attached({
			method: ["post"],
			match: (request) => request.headers["x-ok"] === "1",
		});
		expect((await context.dispatch("http://app.test/api/x")).outcome.kind).toBe(
			"network",
		);
		expect(
			(await context.dispatch("http://app.test/api/x", { method: "POST" }))
				.outcome.kind,
		).toBe("network");
		expect(
			(
				await context.dispatch("http://app.test/api/x", {
					method: "POST",
					headers: { "x-ok": "1" },
				})
			).outcome.kind,
		).toBe("fulfill");
		expect((await context.dispatch("http://app.test/other")).outcome.kind).toBe(
			"network",
		);
		expect(handle.hits).toBe(1);
	});

	it("accepts a single method as a string", async () => {
		const { context } = await attached({ method: "GET" });
		expect((await context.dispatch("http://app.test/api/x")).outcome.kind).toBe(
			"fulfill",
		);
	});

	it("counts `times` in handled requests, then retires the rule", async () => {
		const { context, handle } = await attached({ times: 2, method: "POST" });
		// Seen but not handled: does not use up the rule.
		await context.dispatch("http://app.test/api/x");
		await context.dispatch("http://app.test/api/x", { method: "POST" });
		expect(handle.active).toBe(true);
		await context.dispatch("http://app.test/api/x", { method: "POST" });
		expect(handle.active).toBe(false);
		expect(
			(await context.dispatch("http://app.test/api/x", { method: "POST" }))
				.outcome.kind,
		).toBe("network");
		expect(handle.hits).toBe(2);
	});

	it("gives the last of a rule's `times` to one of two requests in flight", async () => {
		const { context, handle } = await attached({ times: 1 });
		const outcomes = await Promise.all([
			context.dispatch("http://app.test/api/x"),
			context.dispatch("http://app.test/api/x"),
		]);
		expect(outcomes.map((o) => o.outcome.kind).sort()).toEqual([
			"fulfill",
			"network",
		]);
		expect(handle.hits).toBe(1);
	});

	it("rejects a non-positive `times`", async () => {
		const { router } = setup();
		await expect(router.add(rule({ times: 0 }))).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
		await expect(router.add(rule({ times: 1.5 }))).rejects.toThrow(
			/positive integer/,
		);
	});

	it("aborts, defaulting the error code, and records the fault", async () => {
		const { context, timeline, router } = await attached({
			handle: () => ({ type: "abort" }),
		});
		expect((await context.dispatch("http://app.test/api/x")).outcome).toEqual({
			kind: "abort",
			error: "failed",
		});
		// One fault: the browser's own `requestfailed` for the aborted request
		// is the stub's doing, not a network failure to record again.
		expect(timeline.frames().map((f) => [f.kind, f.source])).toEqual([
			["request", "page"],
			["fault", "stub"],
		]);
		expect(timeline.last()).toMatchObject({
			meta: { reason: "abort", error: "failed" },
		});
		await router.add(
			rule({
				record: false,
				handle: () => ({ type: "abort", error: "timedout" }),
			}),
		);
		expect((await context.dispatch("http://app.test/api/x")).outcome).toEqual({
			kind: "abort",
			error: "timedout",
		});
	});

	it("names endpoints through the rule", async () => {
		const { context, timeline } = await attached({
			endpoint: () => "pkg.Svc/Method",
		});
		await context.dispatch("http://app.test/api/x");
		expect(timeline.frames().map((f) => f.endpoint)).toEqual([
			"pkg.Svc/Method",
			"pkg.Svc/Method",
		]);
	});
});

describe("http router: a chain of rules", () => {
	it("lets the newest rule win and hands over on fallback", async () => {
		const { router, context } = await attached();
		await router.add(rule({ handle: () => ({ type: "fallback" }) }));
		const newest = await router.add(
			rule({ handle: () => ({ type: "fulfill", body: "new" }) }),
		);
		const first = await context.dispatch("http://app.test/api/x");
		expect(
			first.outcome.kind === "fulfill" && first.outcome.body.toString(),
		).toBe("new");
		await newest.remove();
		expect(newest.active).toBe(false);
		const second = await context.dispatch("http://app.test/api/x");
		// The fallback rule passes on; the oldest rule answers.
		expect(
			second.outcome.kind === "fulfill" && second.outcome.body.toString(),
		).toBe("ok");
		// Removing twice is harmless.
		await newest.remove();
	});

	it("makes one exchange of a request several rules see", async () => {
		const { router, context, timeline } = await attached({
			handle: () => ({ type: "fulfill", body: "stubbed" }),
		});
		const views: HttpRequestView[] = [];
		const onPassthroughResponse = vi.fn();
		const spy = await router.add(
			rule({
				label: "spy",
				match: (view) => {
					views.push(view);
					return true;
				},
				handle: (view) => {
					views.push(view);
					return { type: "fallback" };
				},
				onPassthroughResponse,
			}),
		);
		await context.dispatch("http://app.test/api/x");
		// One request frame and one response frame under one correlation: the
		// spy and the stub recorded the same exchange, not one each.
		expect(kinds(timeline)).toEqual(["request page x1", "response stub x1"]);
		// The stub answered, so there was no network response to observe.
		expect(onPassthroughResponse).not.toHaveBeenCalled();
		expect(views[0]).toBe(views[1]);
		expect(spy.hits).toBe(1);
	});

	it("gives every rule of a request the same view", async () => {
		const { router, context } = await attached();
		const seen: HttpRequestView[] = [];
		for (const label of ["a", "b"])
			await router.add(
				rule({
					label,
					handle: (view) => {
						seen.push(view);
						return { type: "fallback" };
					},
				}),
			);
		await context.dispatch("http://app.test/api/x");
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]);
	});

	it("closes the exchange for every protocol that recorded its request", async () => {
		const { router, context, timeline } = await attached({
			protocol: "decoded",
			record: false,
			handle: () => ({ type: "fulfill", status: 202 }),
		});
		await router.add(
			rule({ protocol: "raw", handle: () => ({ type: "fallback" }) }),
		);
		await context.dispatch("http://app.test/api/x");
		expect(
			timeline.frames().map((f) => [f.protocol, f.kind, f.source]),
		).toEqual([
			["raw", "request", "page"],
			["raw", "response", "stub"],
		]);
	});

	it("skips a rule that was removed while the request was being read", async () => {
		const { router, context, handle } = await attached();
		const newer = await router.add(
			rule({ handle: () => ({ type: "fulfill", body: "newer" }) }),
		);
		const pending = context.dispatch("http://app.test/api/x");
		// The chain is already picked; the newest rule goes before its turn.
		await newer.remove();
		const { outcome } = await pending;
		expect(outcome.kind === "fulfill" && outcome.body.toString()).toBe("ok");
		expect(handle.hits).toBe(1);
		expect(newer.hits).toBe(0);
	});

	it("does not let a rule added mid-request join that request's chain", async () => {
		const { router, context } = await attached({
			handle: async () => {
				await router.add(
					rule({ handle: () => ({ type: "fulfill", body: "late" }) }),
				);
				return { type: "fallback" };
			},
		});
		expect((await context.dispatch("http://app.test/api/x")).outcome.kind).toBe(
			"network",
		);
		const next = await context.dispatch("http://app.test/api/x");
		expect(
			next.outcome.kind === "fulfill" && next.outcome.body.toString(),
		).toBe("late");
	});
});

describe("http router: the network's answer", () => {
	it("observes a passthrough response without recording it", async () => {
		const onPassthroughResponse = vi.fn();
		const { context, timeline } = await attached({
			record: false,
			handle: () => ({ type: "fallback" }),
			onPassthroughResponse,
		});
		const { request } = await context.dispatch("http://app.test/api/x");
		request.responseValue = fakeResponse(200, {}, "seen");
		context.emit("requestfinished", request);
		await vi.waitFor(() => expect(onPassthroughResponse).toHaveBeenCalled());
		expect(onPassthroughResponse.mock.calls[0]?.[1]).toMatchObject({
			method: "GET",
		});
		expect(timeline.size).toBe(0);
	});

	it("continues with every rewrite, then records the network's answer", async () => {
		const onPassthroughResponse = vi.fn();
		const { context, timeline } = await attached({
			handle: () => ({
				type: "continue",
				url: "http://elsewhere.test/x",
				method: "PUT",
				headers: { a: "b" },
				body: "rewritten",
			}),
			onPassthroughResponse,
		});
		const { outcome, request } = await context.dispatch(
			"http://app.test/api/x",
		);
		expect(outcome).toEqual({
			kind: "continue",
			options: {
				url: "http://elsewhere.test/x",
				method: "PUT",
				headers: { a: "b" },
				postData: Buffer.from("rewritten"),
			},
		});
		request.responseValue = fakeResponse(
			200,
			{ "content-type": "text/plain" },
			"real",
		);
		context.emit("requestfinished", request);
		await vi.waitFor(() => expect(onPassthroughResponse).toHaveBeenCalled());
		expect(onPassthroughResponse.mock.calls[0]?.[0]).toMatchObject({
			status: 200,
		});
		expect(timeline.last()).toMatchObject({
			kind: "response",
			source: "network",
			meta: { status: 200 },
		});
		expect(timeline.last()?.payload.text()).toBe("real");
	});

	it("continues unchanged and records a response whose body is gone", async () => {
		const { context, timeline } = await attached({
			handle: () => ({ type: "continue" }),
		});
		const { outcome, request } = await context.dispatch(
			"http://app.test/api/x",
		);
		expect(outcome).toEqual({ kind: "continue", options: {} });
		request.responseValue = fakeResponse(
			302,
			{},
			new Error("no body for redirects"),
		);
		context.emit("requestfinished", request);
		await vi.waitFor(() => expect(timeline.last()?.kind).toBe("response"));
		expect(timeline.last()?.payload.empty).toBe(true);
	});

	it("tells every rule that passed the request on, newest first", async () => {
		const order: string[] = [];
		const { router, context } = await attached({
			record: false,
			handle: () => ({ type: "fallback" }),
			onPassthroughResponse: () => order.push("older"),
		});
		await router.add(
			rule({
				record: false,
				handle: () => ({ type: "fallback" }),
				onPassthroughResponse: () => order.push("newer"),
			}),
		);
		// A rule with nothing to say is passed over.
		await router.add(
			rule({ record: false, handle: () => ({ type: "fallback" }) }),
		);
		const { request } = await context.dispatch("http://app.test/api/x");
		request.responseValue = fakeResponse(200, {}, "x");
		context.emit("requestfinished", request);
		await vi.waitFor(() => expect(order).toEqual(["newer", "older"]));
	});

	it("keeps going when one observer throws", async () => {
		const older = vi.fn();
		const harness = await attached({
			handle: () => ({ type: "fallback" }),
			onPassthroughResponse: older,
		});
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		await harness.router.add(
			rule({
				label: "broken observer",
				handle: () => ({ type: "fallback" }),
				onPassthroughResponse: () => {
					throw new Error("observer bug");
				},
			}),
		);
		const { request } = await harness.context.dispatch("http://app.test/api/x");
		request.responseValue = fakeResponse(200, {}, "x");
		harness.context.emit("requestfinished", request);
		await vi.waitFor(() => expect(older).toHaveBeenCalled());
		expect(error).toHaveBeenCalledWith(
			"passthrough observer failed",
			{ rule: "broken observer" },
			expect.any(Error),
		);
		expect(harness.timeline.last()).toMatchObject({ kind: "response" });
	});

	it("lets a reader wait for the responses that are already back", async () => {
		const { router, context, timeline } = await attached({
			handle: () => ({ type: "fallback" }),
		});
		const { request } = await context.dispatch("http://app.test/api/x");
		let release!: (body: Buffer) => void;
		request.responseValue = {
			...fakeResponse(200, {}, ""),
			// Reading the body is a round trip to the browser.
			body: () =>
				new Promise<Buffer>((resolve) => {
					release = resolve;
				}),
		};
		context.emit("requestfinished", request);
		let settled = false;
		const settling = router.settle().then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(release).toBeDefined());
		expect(settled).toBe(false);
		expect(timeline.frames().map((f) => f.kind)).toEqual(["request"]);
		release(Buffer.from("real"));
		await settling;
		// By the time settle() returns, the response is on the timeline.
		expect(timeline.frames().map((f) => f.kind)).toEqual([
			"request",
			"response",
		]);
		// With nothing in flight it returns at once.
		await router.settle();
	});

	it("goes on after timeoutMs without a body that does not come, and records it when it does", async () => {
		const harness = await attached({ handle: () => ({ type: "fallback" }) });
		const warn = vi.spyOn(harness.log, "warn").mockImplementation(() => {});
		const { request } = await harness.context.dispatch("http://app.test/api/x");
		let release!: (body: Buffer) => void;
		request.responseValue = {
			...fakeResponse(200, {}, ""),
			// Behind a dialog, the browser hands over no body until it closes.
			body: () =>
				new Promise<Buffer>((resolve) => {
					release = resolve;
				}),
		};
		harness.context.emit("requestfinished", request);
		const settling = harness.router.settle().then(() => "settled");
		await harness.clock.advance(TIMEOUT_MS);
		expect(
			await Promise.race([
				settling,
				new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
			]),
		).toBe("settled");
		expect(warn).toHaveBeenCalledWith(
			"a response did not hand over its body in time; reads go on without it until it does (is a dialog open?)",
			{ url: "http://app.test/api/x", timeoutMs: TIMEOUT_MS },
		);
		// A later read does not wait for it again.
		await harness.router.settle();
		expect(harness.timeline.frames().map((f) => f.kind)).toEqual(["request"]);
		release(Buffer.from("late"));
		await vi.waitFor(() =>
			expect(harness.timeline.last()?.payload.text()).toBe("late"),
		);
	});

	it("ignores a finished request with no response, or one it never saw", async () => {
		const { context, timeline } = await attached({
			handle: () => ({ type: "fallback" }),
		});
		const { request } = await context.dispatch("http://app.test/api/x");
		context.emit("requestfinished", request);
		context.emit("requestfinished", request);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(timeline.frames().map((f) => f.kind)).toEqual(["request"]);
	});

	it("does not track passthroughs it neither records nor observes", async () => {
		const { context, timeline } = await attached({
			record: false,
			handle: () => ({ type: "fallback" }),
		});
		const { request } = await context.dispatch("http://app.test/api/x");
		request.responseValue = fakeResponse(200, {}, "x");
		context.emit("requestfinished", request);
		context.emit("requestfailed", request);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(timeline.size).toBe(0);
	});

	it("warns when reading a passthrough response throws", async () => {
		const harness = await attached({ handle: () => ({ type: "fallback" }) });
		const warn = vi.spyOn(harness.log, "warn").mockImplementation(() => {});
		const { request } = await harness.context.dispatch("http://app.test/api/x");
		vi.spyOn(request, "response").mockRejectedValue(new Error("gone"));
		harness.context.emit("requestfinished", request);
		await vi.waitFor(() => expect(warn).toHaveBeenCalled());
	});

	it("records a network failure as a fault and tells the rules that passed", async () => {
		const onPassthroughFailure = vi.fn();
		const { context, timeline } = await attached({
			handle: () => ({ type: "fallback" }),
			onPassthroughFailure,
		});
		const { request } = await context.dispatch("http://app.test/api/x");
		request.failureText = "net::ERR_CONNECTION_RESET";
		context.emit("requestfailed", request);
		context.emit("requestfailed", request);
		expect(timeline.frames().map((f) => f.kind)).toEqual(["request", "fault"]);
		expect(timeline.last()).toMatchObject({
			kind: "fault",
			source: "network",
			meta: { reason: "network", error: "net::ERR_CONNECTION_RESET" },
		});
		expect(onPassthroughFailure).toHaveBeenCalledTimes(1);
		expect(onPassthroughFailure).toHaveBeenCalledWith(
			"net::ERR_CONNECTION_RESET",
			expect.objectContaining({ method: "GET" }),
		);
		// An observer alone, with nothing recorded, still hears of the failure.
		const quiet = await attached({
			record: false,
			onPassthroughFailure,
			handle: () => ({ type: "fallback" }),
		});
		const second = await quiet.context.dispatch("http://app.test/api/x");
		quiet.context.emit("requestfailed", second.request);
		expect(quiet.timeline.size).toBe(0);
		expect(onPassthroughFailure).toHaveBeenCalledTimes(2);
		expect(onPassthroughFailure).toHaveBeenLastCalledWith(
			undefined,
			expect.anything(),
		);
	});
});

describe("http router: streams", () => {
	/** A rule that opens a stream and hands it to the test. */
	const streaming = (opened: ResponseStream[] = []) => ({
		opened,
		rule: {
			handle: () => ({
				type: "stream" as const,
				open(stream: ResponseStream) {
					opened.push(stream);
				},
			}),
		} satisfies Partial<HttpRule>,
	});

	it("answers with a response the rule writes at its own pace", async () => {
		const { opened, rule: over } = streaming();
		const { context, timeline } = await attached(over);
		const fetching = context.fetch()("http://app.test/api/stream", {
			headers: { "x-from": "the page" },
		});
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		const [stream] = opened as [ResponseStream];
		expect(stream.requestHeaders["x-from"]).toBe("the page");
		// With no head set, the first chunk carries a bare 200.
		await stream.write("one");
		const response = await fetching;
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		const read = async () =>
			new TextDecoder().decode((await reader?.read())?.value);
		expect(await read()).toBe("one");
		await stream.write(new TextEncoder().encode("two"));
		expect(await read()).toBe("two");
		await stream.end();
		expect((await reader?.read())?.done).toBe(true);
		await expect(stream.closed).resolves.toBe("ended");
		// Ending twice, cutting after the end and writing after it are all inert.
		await stream.end();
		stream.cut();
		await expect(stream.write("late")).rejects.toMatchObject({
			code: "CLOSED",
		});
		await vi.waitFor(() =>
			expect(timeline.frames().map((f) => [f.kind, f.source])).toEqual([
				["request", "page"],
				["lifecycle", "stub"],
			]),
		);
		expect(timeline.last()?.meta).toEqual({ event: "close", end: "ended" });
	});

	it("sends the head it is given, at once when flushed", async () => {
		const { opened, rule: over } = streaming();
		const { context } = await attached(over);
		const fetching = context.fetch()("http://app.test/api/stream");
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		const [stream] = opened as [ResponseStream];
		stream.head(202, { "content-type": "text/event-stream" });
		// With no body yet, the page is still waiting — until the flush.
		stream.flush();
		const response = await fetching;
		expect(response.status).toBe(202);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		await stream.end();
	});

	it("records a cut as a fault, and the page letting go as its own doing", async () => {
		const { opened, rule: over } = streaming();
		const { context, timeline } = await attached(over);
		const cutting = context.fetch()("http://app.test/api/a");
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		const [first] = opened as [ResponseStream];
		await first.write("x");
		const cut = await cutting;
		first.cut();
		await expect(first.closed).resolves.toBe("cut");
		await expect(cut.text()).rejects.toThrow();
		// Cutting twice, or ending what was cut, changes nothing.
		first.cut();
		await first.end();

		const leaving = new AbortController();
		const left = context.fetch()("http://app.test/api/b", {
			signal: leaving.signal,
		});
		await vi.waitFor(() => expect(opened).toHaveLength(2));
		const second = opened[1] as ResponseStream;
		await second.write("y");
		await (await left).body?.getReader().read();
		leaving.abort();
		await expect(second.closed).resolves.toBe("cancelled");
		// A stream the page already let go of ends without waiting for it.
		await second.end();
		await vi.waitFor(() =>
			expect(
				timeline
					.frames()
					.filter((f) => f.kind !== "request")
					.map((f) => [f.kind, f.source, f.meta]),
			).toEqual([
				["fault", "stub", { reason: "cut" }],
				["lifecycle", "page", { event: "close", end: "cancelled" }],
			]),
		);
	});

	it("grants local-network-access to the page's origin before each stream", async () => {
		const { opened, rule: over } = streaming();
		const { context } = await attached(over);
		const page = context.newPage();
		const order: string[] = [];
		const grants: (() => void)[] = [];
		context.grantPermissions = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					order.push("grant requested");
					grants.push(() => {
						order.push("granted");
						resolve();
					});
				}),
		);
		const fetches = [
			context.fetch({ page })("http://localhost:4510/api/a"),
			context.fetch({ page })("http://localhost:4510/api/b"),
		];
		await vi.waitFor(() =>
			expect(order).toEqual(["grant requested", "grant requested"]),
		);
		// Neither request has been sent on: each waits for its own grant.
		expect(opened).toHaveLength(0);
		grants[0]?.();
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		grants[1]?.();
		await vi.waitFor(() => expect(opened).toHaveLength(2));
		// Not once per context: a test that clears its permissions, or grants
		// that origin others, must not leave later streams without it.
		expect(context.grantPermissions).toHaveBeenCalledTimes(2);
		expect(context.grantPermissions).toHaveBeenCalledWith(
			["local-network-access"],
			{ origin: "http://localhost:4510" },
		);
		for (const stream of opened) await stream.end();
		await Promise.all(fetches);
	});

	it("grants nothing where Chromium needs no grant or cannot use one", async () => {
		const harness = setup();
		// A stream server that takes any scheme, so an https page gets as far
		// as the grant; the browser never comes, which is all this needs.
		const router = createHttpRouter({
			timeline: harness.timeline,
			log: harness.log,
			streams: {
				open: async (_handler, { secure }) => ({
					id: "s1",
					url: `${secure ? "https" : "http"}://127.0.0.1:1/__wirestage/s1`,
					dispose: () => {},
				}),
			},
			pageId: createObjectIds("p"),
			correlation: createSequence("x"),
			clock: harness.clock,
			timeoutMs: TIMEOUT_MS,
		});
		const { context } = harness;
		await router.attach(harness.attachment);
		await router.add(rule(streaming().rule));
		const page = context.newPage();
		const grant = vi.fn().mockResolvedValue(undefined);
		context.grantPermissions = grant;
		/** Every one is redirected all the same, grant or not. */
		const redirected = async (...args: Parameters<typeof context.dispatch>) =>
			expect((await context.dispatch(...args)).outcome.kind).toBe("continue");
		// Not a secure context: Chromium refuses it loopback, granted or not.
		await redirected("http://app.test/api/a", { page });
		// A service worker's request has no page whose origin could hold it.
		await redirected("http://localhost:4510/api/b", { frameless: true });
		// Nor has a frame that has shown no document yet.
		await redirected("http://localhost:4510/api/c", {
			frame: { url: () => "", page: () => page },
		});
		expect(grant).not.toHaveBeenCalled();
		// https anywhere, and http on a loopback host, are secure contexts.
		for (const origin of [
			"https://app.test",
			"http://127.0.0.1:4510",
			"http://shop.localhost",
			"http://[::1]:4510",
		])
			await redirected(`${origin}/api/d`, { page });
		expect(grant.mock.calls.map((call) => call[1])).toEqual([
			{ origin: "https://app.test" },
			{ origin: "http://127.0.0.1:4510" },
			{ origin: "http://shop.localhost" },
			{ origin: "http://[::1]:4510" },
		]);
		await router.detach(harness.attachment);
	});

	it("grants nothing to a page a loopback server served, but does once its document comes from elsewhere", async () => {
		const { context } = await attached(streaming().rule);
		const page = context.newPage();
		const grant = vi.fn().mockResolvedValue(undefined);
		context.grantPermissions = grant;
		const frame = { url: () => "http://localhost:3000/app", page: () => page };
		/** The frame's document arrives, from `ipAddress`, or from a route (null). */
		const load = async (
			ipAddress: string | null,
			url = "http://localhost:3000/",
		) => {
			const { request } = await context.dispatch(url, {
				resourceType: "document",
				frame,
			});
			request.responseValue = {
				...fakeResponse(200, {}, "<!doctype html>"),
				serverAddr: async () =>
					ipAddress === null ? null : { ipAddress, port: 3000 },
			};
			context.emit("requestfinished", request);
			// Telling where it came from is two round trips to the browser.
			await new Promise((resolve) => setImmediate(resolve));
		};
		const stream = () =>
			context.dispatch("http://localhost:3000/api/feed", { frame });
		for (const loopback of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
			await load(loopback);
			await stream();
		}
		// Its document came from loopback: there is no address space to cross.
		expect(grant).not.toHaveBeenCalled();
		// The same frame now shows a document a route fulfilled.
		await load(null);
		await stream();
		expect(grant).toHaveBeenCalledTimes(1);
		// One from a server that is not on loopback needs it as well.
		await load("192.168.1.20");
		await stream();
		expect(grant).toHaveBeenCalledTimes(2);
		// A loopback document of another origin says nothing of this one.
		await load("127.0.0.1", "http://other.localhost/");
		await stream();
		expect(grant).toHaveBeenCalledTimes(3);
		// Back on its own loopback server, it needs none again.
		await load("127.0.0.1");
		await stream();
		expect(grant).toHaveBeenCalledTimes(3);
		// A finished document with no response to read is no proof either.
		const { request } = await context.dispatch("http://localhost:3000/", {
			resourceType: "document",
			frame,
		});
		context.emit("requestfinished", request);
		await new Promise((resolve) => setImmediate(resolve));
		await stream();
		expect(grant).toHaveBeenCalledTimes(4);
	});

	it("notes nothing of a document it cannot place", async () => {
		const harness = await attached(streaming().rule);
		const debug = vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		const { request } = await harness.context.dispatch(
			"http://localhost:3000/",
			{
				resourceType: "document",
				frameless: true,
			},
		);
		harness.context.emit("requestfinished", request);
		await vi.waitFor(() =>
			expect(debug).toHaveBeenCalledWith(
				"could not tell where a document came from",
				{ url: "http://localhost:3000/" },
				expect.any(Error),
			),
		);
	});

	it("goes on when the browser does not know the permission", async () => {
		const { opened, rule: over } = streaming();
		const refused = await attached(over);
		const debug = vi.spyOn(refused.log, "debug").mockImplementation(() => {});
		refused.context.grantPermissions = vi
			.fn()
			.mockRejectedValue(new Error("Unknown permission"));
		const page = refused.context.newPage();
		const fetching = refused.context.fetch({ page })(
			"http://localhost:4510/api/c",
		);
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		await opened[0]?.end();
		await fetching;
		expect(debug).toHaveBeenCalledWith(
			"local-network-access not granted",
			{ origin: "http://localhost:4510" },
			expect.any(Error),
		);
	});

	it("answers a stream rule that throws before anything went out as a throwing fulfill is answered", async () => {
		const harness = await attached({
			label: "feed",
			handle: () => ({
				type: "stream",
				open(stream) {
					// Held back until the first write, so the page never sees it.
					stream.head(200, {
						"content-type": "application/x-ndjson",
						"content-encoding": "gzip",
					});
					// The ndjson example of docs/plugins.md, given a bigint.
					return stream.write(`${JSON.stringify({ id: 1n })}\n`);
				},
			}),
		});
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		const response = await harness.context.fetch()("http://app.test/api/feed");
		expect(response.status).toBe(500);
		// The rule's head is gone; the stream server's own headers stay.
		expect(response.headers.get("content-encoding")).toBeNull();
		expect(response.headers.get("connection")).toBe("close");
		expect(await response.text()).toBe(
			'wirestage: rule "feed" failed: Do not know how to serialize a BigInt',
		);
		await harness.router.settle();
		// The rule's error, not the page letting go.
		expect(
			harness.timeline.frames().map((f) => [f.kind, f.source, f.meta]),
		).toEqual([
			["request", "page", expect.anything()],
			[
				"fault",
				"stub",
				{
					reason: "rule-error",
					error: "Do not know how to serialize a BigInt",
				},
			],
		]);
		expect(error).toHaveBeenCalledWith(
			"rule failed",
			{ rule: "feed", url: "http://app.test/api/feed" },
			expect.any(TypeError),
		);
	});

	it("cuts a stream whose rule throws once the head went out", async () => {
		const harness = await attached({
			handle: () => ({
				type: "stream",
				async open(stream) {
					stream.head(200, { "content-type": "application/x-ndjson" });
					await stream.write('{"n":1}\n');
					throw new Error("bug mid-stream");
				},
			}),
		});
		vi.spyOn(harness.log, "error").mockImplementation(() => {});
		const response = await harness.context.fetch()("http://app.test/api/feed");
		expect(response.status).toBe(200);
		// Not a clean end: that would pass for the whole response.
		await expect(response.text()).rejects.toThrow();
		await harness.router.settle();
		expect(harness.timeline.frames().map((f) => f.meta["reason"])).toEqual([
			undefined,
			"rule-error",
		]);
	});

	it("refuses a status Node would refuse when the head is set, while the 500 can still be sent", async () => {
		const harness = await attached({
			handle: () => ({
				type: "stream",
				async open(stream) {
					// Node would refuse it from end(), and send the 500 with no body.
					stream.head(1000);
					await stream.end();
				},
			}),
		});
		vi.spyOn(harness.log, "error").mockImplementation(() => {});
		const response = await harness.context.fetch()("http://app.test/api/feed");
		expect(response.status).toBe(500);
		expect(await response.text()).toBe(
			'wirestage: rule "test rule" failed: a response status is an integer from 100 to 999, got 1000',
		);
	});

	it("files a rule that stops once its stream was over as that end, not as an error", async () => {
		const harness = await attached({
			handle: () => ({
				type: "stream",
				async open(stream) {
					stream.flush();
					await stream.closed;
					// What a write into a stream the page let go of rejects with.
					throw new Error("the response stream is closed");
				},
			}),
		});
		const debug = vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		const leaving = new AbortController();
		await harness.context.fetch()("http://app.test/api/feed", {
			signal: leaving.signal,
		});
		leaving.abort();
		await vi.waitFor(() =>
			expect(debug).toHaveBeenCalledWith(
				"a stream's rule failed after the stream was over",
				{ rule: "test rule" },
				expect.any(Error),
			),
		);
		expect(harness.timeline.last()?.meta).toEqual({
			event: "close",
			end: "cancelled",
		});
	});

	it("sends each of a header's values on a line of its own, and keeps the connection the server's", async () => {
		const { opened, rule: over } = streaming();
		const { context } = await attached(over);
		const fetching = context.fetch()("http://app.test/api/feed");
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		const [stream] = opened as [ResponseStream];
		// A first head is replaced while nothing has gone out.
		stream.head(201, { "x-first": "1" });
		// Connect's and the contract's spelling of several cookies.
		stream.head(200, {
			"set-cookie": "a=1; Path=/\nb=2; Path=/",
			connection: "keep-alive",
		});
		stream.flush();
		const response = await fetching;
		expect(response.status).toBe(200);
		expect(response.headers.get("x-first")).toBeNull();
		expect(response.headers.getSetCookie()).toEqual([
			"a=1; Path=/",
			"b=2; Path=/",
		]);
		expect(response.headers.get("connection")).toBe("close");
		// Too late once it went out, as Node says.
		expect(() => stream.head(204)).toThrow(/headers after they are sent/);
		await stream.end();
	});

	it("records an end before end() resolves, and makes a read wait for a cut", async () => {
		const { opened, rule: over } = streaming();
		const { context, timeline, router } = await attached(over);
		const ended = context.fetch()("http://app.test/api/a");
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		await opened[0]?.write("x");
		await ended;
		await opened[0]?.end();
		// The raw timeline: nothing to wait for any more.
		expect(timeline.last()?.meta).toEqual({ event: "close", end: "ended" });
		const cutting = context.fetch()("http://app.test/api/b");
		await vi.waitFor(() => expect(opened).toHaveLength(2));
		await opened[1]?.write("y");
		await cutting;
		// The contract's cut() returns at once; the close comes a turn later.
		opened[1]?.cut();
		await router.settle();
		expect(timeline.last()?.meta).toEqual({ reason: "cut" });
	});

	it("gives a stream up when the browser never brings its request", async () => {
		const harness = await attached(streaming().rule);
		const warn = vi.spyOn(harness.log, "warn").mockImplementation(() => {});
		// The fake leaves a redirect unfollowed, as a page that went away does.
		await harness.context.dispatch("http://app.test/api/feed");
		expect(harness.streams.sessions).toBe(1);
		await harness.clock.advance(TIMEOUT_MS);
		// Its place on the stream server is free again, and the exchange ends.
		expect(harness.streams.sessions).toBe(0);
		expect(harness.timeline.last()).toMatchObject({
			kind: "fault",
			source: "stub",
			meta: {
				reason: "unreached",
				error: `the browser did not bring the request to the stream server within ${TIMEOUT_MS} ms`,
			},
		});
		expect(warn).toHaveBeenCalledWith(
			"a live stream's request never reached the stream server, and was given up",
			{ url: "http://app.test/api/feed", timeoutMs: TIMEOUT_MS },
		);
	});

	it("gives a stream up at once when the page lets go of it first", async () => {
		const harness = await attached(streaming().rule);
		const { request } = await harness.context.dispatch(
			"http://app.test/api/feed",
		);
		// Just after the redirect: Playwright says the request failed.
		request.failureText = "net::ERR_ABORTED";
		harness.context.emit("requestfailed", request);
		expect(harness.streams.sessions).toBe(0);
		expect(harness.timeline.last()).toMatchObject({
			kind: "fault",
			source: "network",
			meta: { reason: "network", error: "net::ERR_ABORTED" },
		});
		// Nothing more comes of it: not the deadline, not another failure.
		await harness.clock.advance(TIMEOUT_MS);
		harness.context.emit("requestfailed", request);
		expect(harness.timeline.size).toBe(2);
	});

	it("gives a stream up at once when the page let go while the rule decided", async () => {
		const harness = await captured(streaming().rule);
		await harness.run((request) => ({
			// Playwright takes the redirect of a request that already failed.
			async continue() {
				request.failureText = "net::ERR_ABORTED";
			},
		}));
		expect(harness.streams.sessions).toBe(0);
		expect(harness.timeline.last()?.meta).toEqual({
			reason: "network",
			error: "net::ERR_ABORTED",
		});
	});

	it("gives up the streams of a context as it is detached, and only those", async () => {
		const harness = await attached(streaming().rule);
		const other = createFakeContext();
		const second = attachmentOf("c2", other);
		await harness.router.attach(second);
		await harness.context.dispatch("http://app.test/api/a");
		await other.dispatch("http://app.test/api/b");
		expect(harness.streams.sessions).toBe(2);
		await harness.router.detach(harness.attachment);
		expect(harness.streams.sessions).toBe(1);
		expect(harness.timeline.last()).toMatchObject({
			context: "c1",
			meta: { reason: "unreached", error: "the context was detached first" },
		});
		await harness.router.detach(second);
		expect(harness.streams.sessions).toBe(0);
	});

	it("does not wait for a stream the browser brought before the redirect returned", async () => {
		const { opened, rule: over } = streaming();
		const harness = await captured(over);
		let reading: Promise<Response> | undefined;
		await harness.run({
			async continue(options) {
				// Chromium can reach the stream server before Playwright answers.
				reading = fetch(options?.url as string);
				await vi.waitFor(() => expect(opened).toHaveLength(1));
			},
		});
		await harness.clock.advance(TIMEOUT_MS);
		await opened[0]?.write("on time");
		const response = await reading;
		await opened[0]?.end();
		expect(await response?.text()).toBe("on time");
		// Its end, and no giving up on it.
		expect(harness.timeline.frames().map((f) => f.meta["reason"])).toEqual([
			undefined,
			undefined,
		]);
	});

	it("disposes the session when the redirect fails", async () => {
		const harness = await captured(streaming().rule);
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		const fulfill = vi.fn().mockResolvedValue(undefined);
		await harness.run({
			fulfill,
			continue: vi.fn().mockRejectedValue(new Error("page closed")),
		});
		expect(harness.streams.sessions).toBe(0);
		// The failed redirect was the route's one answer: the 500 is refused,
		// and said so at error, since the page is left waiting.
		expect(fulfill).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			"could not answer a failed rule: the request is left without an answer",
			{ rule: "test rule", url: "http://app.test/api/x" },
			expect.objectContaining({ message: "Route is already handled!" }),
		);
	});
});

describe("http router: failures stay inside", () => {
	it("answers 500 when a rule throws, naming the rule", async () => {
		const harness = await attached({
			handle: () => {
				throw new Error("bug in the stub");
			},
		});
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		const { outcome } = await harness.context.dispatch("http://app.test/api/x");
		expect(outcome).toMatchObject({ kind: "fulfill", status: 500 });
		expect(outcome.kind === "fulfill" && outcome.body.toString()).toBe(
			'wirestage: rule "test rule" failed: bug in the stub',
		);
		expect(harness.timeline.last()).toMatchObject({
			kind: "fault",
			endpoint: "/api/x",
			meta: { reason: "rule-error", error: "bug in the stub" },
		});
		expect(error).toHaveBeenCalled();

		await harness.router.add(
			rule({
				label: "string thrower",
				handle: () => {
					throw "not an Error";
				},
			}),
		);
		const second = await harness.context.dispatch("http://app.test/api/x");
		expect(
			second.outcome.kind === "fulfill" && second.outcome.body.toString(),
		).toContain("not an Error");
	});

	it("answers the rule's 500 for an answer Playwright or Chromium would refuse", async () => {
		const answers: [string, HttpRule["handle"], string][] = [
			[
				"continue to another scheme",
				() => ({ type: "continue", url: "https://app.test/api/x" }),
				"continue cannot change the scheme (http: to https:): Playwright rewrites a URL within its scheme only",
			],
			[
				"continue to no URL at all",
				() => ({ type: "continue", url: "http://[" }),
				"Invalid URL",
			],
			[
				"continue with a broken header",
				() => ({ type: "continue", headers: { "x-a": "a\nb" } }),
				'the value of header "x-a" has a line break or NUL in it',
			],
			[
				"abort with a code Playwright does not know",
				() => ({ type: "abort", error: "bogus" as never }),
				'"bogus" is not an abort error code; Playwright takes aborted, accessdenied, addressunreachable, blockedbyclient, blockedbyresponse, connectionaborted, connectionclosed, connectionfailed, connectionrefused, connectionreset, internetdisconnected, namenotresolved, timedout, failed',
			],
			[
				"fulfill with a header name that is not a token",
				() => ({ type: "fulfill", headers: { "x bad": "1" } }),
				'"x bad" is not a valid header name',
			],
			[
				"fulfill with a CR in a value",
				() => ({ type: "fulfill", headers: { "x-a": "a\rb" } }),
				'the value of header "x-a" has a line break or NUL in it',
			],
			[
				"fulfill with a NUL in a cookie",
				() => ({ type: "fulfill", headers: { "set-cookie": "a=1\nb=\u0000" } }),
				'the value of header "set-cookie" has a line break or NUL in it',
			],
		];
		for (const [label, handle, message] of answers) {
			const harness = await attached({ label, handle });
			vi.spyOn(harness.log, "error").mockImplementation(() => {});
			// Checked before the route is touched: Playwright marks a route
			// handled before it checks the answer, and the page would hang.
			const { outcome } = await harness.context.dispatch(
				"http://app.test/api/x",
			);
			expect(outcome).toMatchObject({ kind: "fulfill", status: 500 });
			expect(outcome.kind === "fulfill" && outcome.body.toString()).toBe(
				`wirestage: rule "${label}" failed: ${message}`,
			);
			expect(harness.timeline.last()?.meta).toEqual({
				reason: "rule-error",
				error: message,
			});
		}
	});

	it("continues to a URL relative to the request", async () => {
		const { context } = await attached({
			handle: () => ({ type: "continue", url: "v2/thing?q=1" }),
		});
		expect((await context.dispatch("http://app.test/api/x")).outcome).toEqual({
			kind: "continue",
			options: { url: "http://app.test/api/v2/thing?q=1" },
		});
	});

	it("folds a header's several values into one, but sends set-cookie's a line each", async () => {
		const { context, timeline } = await attached({
			handle: () => ({
				type: "fulfill",
				headers: {
					vary: "origin\naccept",
					"set-cookie": "a=1; Path=/\nb=2; Path=/",
				},
				body: "ok",
			}),
		});
		const page = context.newPage();
		const response = await context.fetch({ page })("http://app.test/api/x");
		// Chromium drops a fulfilled response with a newline in any other
		// header, and the request hangs; HTTP joins repeated ones this way.
		expect(response.headers.get("vary")).toBe("origin, accept");
		expect(response.headers.getSetCookie()).toEqual([
			"a=1; Path=/",
			"b=2; Path=/",
		]);
		expect(timeline.last()?.meta["headers"]).toEqual({
			vary: "origin, accept",
			"set-cookie": "a=1; Path=/\nb=2; Path=/",
		});
	});

	it("answers 500 when a rule's match or endpoint throws, instead of hanging", async () => {
		const matching = await attached({
			match: () => {
				throw new Error("bug in match");
			},
		});
		vi.spyOn(matching.log, "error").mockImplementation(() => {});
		const first = await matching.context.dispatch("http://app.test/api/x");
		expect(
			first.outcome.kind === "fulfill" && first.outcome.body.toString(),
		).toBe('wirestage: rule "test rule" failed: bug in match');

		const naming = await attached({
			endpoint: () => {
				throw new Error("bug in endpoint");
			},
		});
		vi.spyOn(naming.log, "error").mockImplementation(() => {});
		const second = await naming.context.dispatch("http://app.test/api/x");
		expect(second.outcome).toMatchObject({ kind: "fulfill", status: 500 });
		// The rule could not name the request; the fault is filed under its path.
		expect(naming.timeline.last()).toMatchObject({
			kind: "fault",
			endpoint: "/api/x",
		});
	});

	it("names a failed rule's fault the way the rule names its requests", async () => {
		const harness = await attached({
			record: false,
			endpoint: () => "pkg.Svc/Method",
			handle: () => {
				throw new Error("x");
			},
		});
		vi.spyOn(harness.log, "error").mockImplementation(() => {});
		await harness.context.dispatch("http://app.test/api/x");
		expect(harness.timeline.frames().map((f) => f.endpoint)).toEqual([
			"pkg.Svc/Method",
		]);
	});

	it("says at error when even the 500 cannot be sent, and at debug once detached", async () => {
		const harness = await captured({
			handle: () => {
				throw new Error("x");
			},
		});
		const debug = vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		const refused = vi.fn().mockRejectedValue(new Error("Target closed"));
		await harness.run({ fulfill: refused });
		// Never rejected to Playwright; the page is left waiting, so it is an
		// error, not a debug line.
		expect(error).toHaveBeenLastCalledWith(
			"could not answer a failed rule: the request is left without an answer",
			{ rule: "test rule", url: "http://app.test/api/x" },
			expect.any(Error),
		);
		await harness.router.detach(harness.attachment);
		await harness.run({ fulfill: refused });
		expect(debug).toHaveBeenLastCalledWith(
			"could not answer a failed rule: the request is left without an answer",
			{ rule: "test rule", url: "http://app.test/api/x" },
			expect.any(Error),
		);
	});

	it("is quiet about a rule that fails after its context was detached", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await captured({
			handle: async () => {
				await held;
				throw new Error("target closed");
			},
		});
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		const debug = vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		const running = harness.run({});
		await vi.waitFor(() => expect(harness.handle.hits).toBe(1));
		await harness.router.detach(harness.attachment);
		release();
		await running;
		expect(error).not.toHaveBeenCalled();
		expect(debug).toHaveBeenCalledWith(
			"rule failed",
			expect.objectContaining({ rule: "test rule" }),
			expect.any(Error),
		);
	});

	it("never rejects to Playwright when the request cannot be read or handed on", async () => {
		const harness = await captured({ handle: () => ({ type: "fallback" }) });
		const warn = vi.spyOn(harness.log, "warn").mockImplementation(() => {});
		const debug = vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		// Handing on fails: the page or context closed under the request.
		await expect(
			harness.run({
				fallback: vi.fn().mockRejectedValue(new Error("Target closed")),
			}),
		).resolves.toBeDefined();
		expect(warn).toHaveBeenCalledWith(
			"request abandoned",
			{ url: "http://app.test/api/x" },
			expect.any(Error),
		);
		// After a detach it is expected, and only worth a debug line.
		await harness.router.detach(harness.attachment);
		await harness.run({
			fallback: vi.fn().mockRejectedValue(new Error("Target closed")),
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(debug).toHaveBeenCalledWith(
			"request abandoned",
			{ url: "http://app.test/api/x" },
			expect.any(Error),
		);
	});

	it("treats a URL matcher that throws as no match, for that rule alone", async () => {
		const harness = await attached();
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		const broken = await harness.router.add(
			rule({
				label: "broken matcher",
				url: () => {
					throw new Error("bug in the predicate");
				},
				handle: () => ({ type: "fulfill", body: "never" }),
			}),
		);
		// Playwright asks this of every request in the context; the older
		// rule still answers.
		const { outcome } = await harness.context.dispatch("http://app.test/api/x");
		expect(outcome.kind === "fulfill" && outcome.body.toString()).toBe("ok");
		expect(broken.hits).toBe(0);
		expect(error).toHaveBeenCalledWith(
			"rule's URL matcher failed",
			{ rule: "broken matcher", url: "http://app.test/api/x" },
			expect.any(Error),
		);
	});

	it("hands on a request no live rule wants any more", async () => {
		const harness = await captured();
		await harness.handle.remove();
		const fallback = vi.fn().mockResolvedValue(undefined);
		// Playwright checked the predicate before the rule was removed.
		await harness.run({ fallback });
		expect(fallback).toHaveBeenCalledTimes(1);
		expect(harness.timeline.size).toBe(0);
	});
});

describe("http router: contexts", () => {
	it("routes nothing until there is a rule, then one route per context", async () => {
		const harness = setup();
		await harness.router.attach(harness.attachment);
		expect(harness.context.routeCount).toBe(0);
		const first = await harness.router.add(rule());
		await harness.router.add(rule());
		expect(harness.context.routeCount).toBe(1);
		// A context attached later gets the rules that already exist.
		const late = createFakeContext();
		await harness.router.attach(attachmentOf("c2", late));
		expect(late.routeCount).toBe(1);
		expect((await late.dispatch("http://app.test/api/x")).outcome.kind).toBe(
			"fulfill",
		);
		await harness.router.detach(harness.attachment);
		expect(harness.context.routeCount).toBe(0);
		// Detaching twice, or a context never attached, is harmless.
		await harness.router.detach(harness.attachment);
		expect(first.hits).toBe(0);
	});

	it("installs one route when rules are added at once", async () => {
		const harness = setup();
		await harness.router.attach(harness.attachment);
		await Promise.all([harness.router.add(rule()), harness.router.add(rule())]);
		expect(harness.context.routeCount).toBe(1);
	});

	it("detaches a context that never needed a route", async () => {
		const harness = setup();
		await harness.router.attach(harness.attachment);
		const unroute = vi.spyOn(harness.context, "unroute");
		await harness.router.detach(harness.attachment);
		expect(unroute).not.toHaveBeenCalled();
	});

	it("tolerates a context that closed before unroute", async () => {
		const harness = await attached();
		const debug = vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		harness.context.failNextUnroute = true;
		await harness.router.detach(harness.attachment);
		expect(debug).toHaveBeenCalledWith(
			"unroute failed",
			{ context: "c1" },
			expect.any(Error),
		);
	});

	it("takes back a rule it could not install everywhere", async () => {
		const harness = setup();
		await harness.router.attach(harness.attachment);
		const route = vi
			.spyOn(harness.context, "route")
			.mockRejectedValueOnce(new Error("context closed"));
		await expect(harness.router.add(rule())).rejects.toThrow("context closed");
		// Not half-installed: the next rule installs the route afresh.
		const next = await harness.router.add(rule());
		expect(route).toHaveBeenCalledTimes(2);
		expect(
			(await harness.context.dispatch("http://app.test/api/x")).outcome.kind,
		).toBe("fulfill");
		expect(next.hits).toBe(1);
	});
});
