import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFakeContext,
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

function setup() {
	const timeline = createTimeline({ clock: createManualClock() });
	const log = createScopedLogger("Http");
	const streams = createStreamServer();
	servers.push(streams);
	const router = createHttpRouter({
		timeline,
		log,
		streams,
		pageId: createObjectIds("p"),
		correlation: createSequence("x"),
	});
	const context = createFakeContext();
	const attachment = attachmentOf("c1", context);
	return { timeline, log, router, context, attachment, streams };
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
	const run = async (
		route: Partial<RoutePort>,
		url = "http://app.test/api/x",
	) => {
		const { request } = await harness.context.dispatch(url);
		await (handler as RouteHandler)(
			{
				request: () => request,
				fulfill: vi.fn().mockResolvedValue(undefined),
				continue: vi.fn().mockResolvedValue(undefined),
				fallback: vi.fn().mockResolvedValue(undefined),
				abort: vi.fn().mockResolvedValue(undefined),
				...route,
			},
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
			status: () => 200,
			headers: () => ({}),
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

	it("grants local-network-access once per context, and makes every stream wait for it", async () => {
		const { opened, rule: over } = streaming();
		const { context } = await attached(over);
		const order: string[] = [];
		let granted!: () => void;
		context.grantPermissions = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					order.push("grant requested");
					granted = () => {
						order.push("granted");
						resolve();
					};
				}),
		);
		const fetches = [
			context.fetch()("http://app.test/api/a"),
			context.fetch()("http://app.test/api/b"),
		];
		await vi.waitFor(() => expect(order).toEqual(["grant requested"]));
		// Neither request has been sent on: both wait for the one grant.
		expect(opened).toHaveLength(0);
		granted();
		await vi.waitFor(() => expect(opened).toHaveLength(2));
		expect(context.grantPermissions).toHaveBeenCalledTimes(1);
		expect(context.grantPermissions).toHaveBeenCalledWith([
			"local-network-access",
		]);
		for (const stream of opened) await stream.end();
		await Promise.all(fetches);
	});

	it("goes on when the browser does not know the permission", async () => {
		const { opened, rule: over } = streaming();
		const refused = await attached(over);
		const debug = vi.spyOn(refused.log, "debug").mockImplementation(() => {});
		refused.context.grantPermissions = vi
			.fn()
			.mockRejectedValue(new Error("Unknown permission"));
		const fetching = refused.context.fetch()("http://app.test/api/c");
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		await opened[0]?.end();
		await fetching;
		expect(debug).toHaveBeenCalledWith(
			"local-network-access not granted",
			{},
			expect.any(Error),
		);
	});

	it("disposes the session when the redirect fails", async () => {
		const harness = await captured(streaming().rule);
		vi.spyOn(harness.log, "error").mockImplementation(() => {});
		const fulfill = vi.fn().mockResolvedValue(undefined);
		await harness.run({
			fulfill,
			continue: vi.fn().mockRejectedValue(new Error("page closed")),
		});
		// The session is forgotten, and the page gets a 500 instead of a hang.
		expect(harness.streams.sessions).toBe(0);
		expect(fulfill).toHaveBeenCalledWith(
			expect.objectContaining({ status: 500 }),
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

	it("swallows the second failure when even the 500 cannot be sent", async () => {
		const harness = await captured({
			handle: () => {
				throw new Error("x");
			},
		});
		const debug = vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		vi.spyOn(harness.log, "error").mockImplementation(() => {});
		await harness.run({
			fulfill: vi.fn().mockRejectedValue(new Error("already answered")),
		});
		expect(debug).toHaveBeenCalledWith(
			"could not answer a failed rule",
			{},
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
