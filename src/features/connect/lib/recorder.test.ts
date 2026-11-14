import { create } from "@bufbuild/protobuf";
import {
	Code,
	ConnectError,
	createContextValues,
	createHandlerContext,
	type HandlerContext,
} from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import {
	EchoRequestSchema,
	EchoService,
} from "../../../__fixtures__/gen/wirestage/test/v1/echo_pb.js";
import { createTimeline } from "../../../entities/frame/index.js";
import { createManualClock } from "../../../shared/lib/clock/index.js";
import {
	type CallInfo,
	callOf,
	createRecorder,
	endpointOf,
	kCall,
	recordingImpl,
	tapIterable,
} from "./recorder.js";

/** A page's call, answered by a stub. Each call is an object of its own. */
const pageCall = (over: Partial<CallInfo> = {}): CallInfo => ({
	correlation: "x1",
	from: "page",
	answeredBy: "stub",
	rpcProtocol: "grpc-web",
	page: "p1",
	context: "c1",
	...over,
});

function setup(withCall = true, over: Partial<CallInfo> = {}) {
	const timeline = createTimeline({ clock: createManualClock() });
	const recorder = createRecorder(timeline, "connect");
	const contextFor = (
		method: (typeof EchoService.methods)[number],
	): HandlerContext =>
		createHandlerContext({
			service: EchoService,
			method,
			protocolName: "test",
			requestMethod: "POST",
			url: "http://h/",
			contextValues: withCall
				? createContextValues().set(kCall, pageCall(over))
				: createContextValues(),
		});
	return { timeline, recorder, contextFor };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const value of iterable) out.push(value);
	return out;
}

async function* from<T>(values: T[]): AsyncGenerator<T> {
	yield* values;
}

describe("recorder", () => {
	it("names endpoints and records who said what", () => {
		const { timeline, recorder } = setup();
		const say = EchoService.method.say;
		expect(endpointOf(say)).toBe("wirestage.test.v1.EchoService/Say");
		const call = pageCall();
		recorder.out(call, say, { text: "init shape" }, true);
		recorder.out(
			call,
			say,
			create(EchoRequestSchema, { text: "message" }),
			false,
		);
		recorder.in(call, say, { text: "reply" });
		recorder.status(call, say);
		const frames = timeline.frames();
		// The request side is the caller's; the answer is whoever answered.
		expect(frames.map((f) => [f.kind, f.direction, f.source])).toEqual([
			["request", "out", "page"],
			["message", "out", "page"],
			["message", "in", "stub"],
			["response", "in", "stub"],
		]);
		expect(frames[0]).toMatchObject({
			protocol: "connect",
			correlation: "x1",
			page: "p1",
			context: "c1",
		});
		expect(frames[0]?.payload.bytes().length).toBeGreaterThan(0);
		expect(frames[2]?.payload.bytes().length).toBeGreaterThan(0);
		expect(frames[3]?.meta).toMatchObject({ code: 0, message: "" });
	});

	it("records the status the page is sent, and what was really thrown", () => {
		const { timeline, recorder } = setup();
		const say = EchoService.method.say;
		recorder.status(pageCall(), say, new ConnectError("nope", Code.NotFound));
		// Anything but a ConnectError reaches the page as "internal error".
		recorder.status(pageCall(), say, new Error("bug in the stub"));
		recorder.statusOf(
			pageCall({ page: undefined, context: undefined, answeredBy: "network" }),
			say,
			{ code: 13, message: "x" },
		);
		const [refused, crashed, wire] = timeline.frames();
		expect(refused?.meta).toEqual({
			rpcProtocol: "grpc-web",
			code: Code.NotFound,
			message: "nope",
		});
		expect(crashed?.meta).toEqual({
			rpcProtocol: "grpc-web",
			code: Code.Internal,
			message: "internal error",
			thrown: "Error: bug in the stub",
		});
		expect(wire).toMatchObject({ source: "network", meta: { code: 13 } });
		expect(wire?.page).toBeUndefined();
	});

	it("ends a call once: what follows a cut is not a second ending", () => {
		const { timeline, recorder } = setup();
		const watch = EchoService.method.watch;
		const call = pageCall();
		recorder.out(call, watch, { text: "x" }, true);
		recorder.in(call, watch, { text: "1" });
		recorder.fault(call, watch, "cut");
		// The implementation returning after the cut must not read as an OK,
		// and nothing it yields afterwards reached the page.
		recorder.in(call, watch, { text: "never delivered" });
		recorder.status(call, watch);
		recorder.statusOf(call, watch, { code: 0, message: "" });
		recorder.fault(call, watch, "abort");
		expect(timeline.frames().map((f) => [f.kind, f.source])).toEqual([
			["request", "page"],
			["message", "stub"],
			["fault", "stub"],
		]);
		expect(timeline.last()?.meta).toEqual({
			rpcProtocol: "grpc-web",
			reason: "cut",
		});
		// And the other way round: a status first, then no fault.
		const done = pageCall({ correlation: "x2" });
		recorder.status(done, watch);
		recorder.fault(done, watch, "cut");
		expect(timeline.frames({ correlation: "x2" }).map((f) => f.kind)).toEqual([
			"response",
		]);
	});

	it("records a fault with its error, by whoever caused it", () => {
		const { timeline, recorder } = setup();
		const say = EchoService.method.say;
		recorder.fault(pageCall({ answeredBy: "network" }), say, "network", {
			error: "net::ERR_CONNECTION_RESET",
		});
		recorder.fault(pageCall(), say, "cancelled", { by: "page" });
		expect(timeline.frames().map((f) => [f.source, f.meta])).toEqual([
			[
				"network",
				{
					rpcProtocol: "grpc-web",
					reason: "network",
					error: "net::ERR_CONNECTION_RESET",
				},
			],
			["page", { rpcProtocol: "grpc-web", reason: "cancelled" }],
		]);
	});

	it("records an unidentified call as anonymous, each on its own", async () => {
		const { timeline, recorder, contextFor } = setup(false);
		const method = EchoService.method.say;
		expect(callOf(contextFor(method)).correlation).toBe("anonymous");
		const impl = recordingImpl(
			method,
			(async () => ({ text: "ok" })) as never,
			recorder,
		) as (r: unknown, c: HandlerContext) => Promise<unknown>;
		await impl(create(EchoRequestSchema), contextFor(method));
		await impl(create(EchoRequestSchema), contextFor(method));
		// The first one ending did not swallow the second one's answer.
		expect(timeline.frames({ kind: "response" })).toHaveLength(2);
	});

	it("taps every value of an iterable with its index", async () => {
		const seen: [string, number][] = [];
		expect(
			await collect(tapIterable(from(["a", "b"]), (v, i) => seen.push([v, i]))),
		).toEqual(["a", "b"]);
		expect(seen).toEqual([
			["a", 0],
			["b", 1],
		]);
	});
});

describe("recordingImpl", () => {
	it("records unary calls and their failures", async () => {
		const { timeline, recorder, contextFor } = setup();
		const method = EchoService.method.say;
		const ok = recordingImpl(
			method,
			(async (r: { text: string }) => ({ text: `re ${r.text}` })) as never,
			recorder,
		) as (r: unknown, c: HandlerContext) => Promise<unknown>;
		await expect(
			ok(create(EchoRequestSchema, { text: "a" }), contextFor(method)),
		).resolves.toEqual({ text: "re a" });
		const failing = recordingImpl(
			method,
			(async () => {
				throw new ConnectError("bad", Code.InvalidArgument);
			}) as never,
			recorder,
		) as (r: unknown, c: HandlerContext) => Promise<unknown>;
		await expect(
			failing(create(EchoRequestSchema), contextFor(method)),
		).rejects.toThrow("bad");
		expect(timeline.frames().map((f) => f.meta["code"])).toEqual([
			undefined,
			undefined,
			0,
			undefined,
			3,
		]);
	});

	it("records server streams, including a stream that fails midway", async () => {
		const { timeline, recorder, contextFor } = setup();
		const method = EchoService.method.watch;
		const stream = recordingImpl(
			method,
			async function* () {
				yield { text: "1" };
				yield { text: "2" };
			} as never,
			recorder,
		) as (r: unknown, c: HandlerContext) => AsyncIterable<unknown>;
		expect(
			await collect(stream(create(EchoRequestSchema), contextFor(method))),
		).toHaveLength(2);
		const failing = recordingImpl(
			method,
			async function* () {
				yield { text: "1" };
				throw new Error("broke");
			} as never,
			recorder,
		) as (r: unknown, c: HandlerContext) => AsyncIterable<unknown>;
		await expect(
			collect(failing(create(EchoRequestSchema), contextFor(method))),
		).rejects.toThrow("broke");
		expect(
			timeline.frames({ kind: "response" }).map((f) => f.meta["code"]),
		).toEqual([0, Code.Internal]);
	});

	it("leaves the request to the rule that already recorded it", async () => {
		const { timeline, recorder, contextFor } = setup(true, {
			requestRecorded: true,
		});
		const unary = recordingImpl(
			EchoService.method.say,
			(async () => ({ text: "ok" })) as never,
			recorder,
		) as (r: unknown, c: HandlerContext) => Promise<unknown>;
		await unary(create(EchoRequestSchema), contextFor(EchoService.method.say));
		const stream = recordingImpl(
			EchoService.method.watch,
			async function* () {
				yield { text: "1" };
			} as never,
			recorder,
		) as (r: unknown, c: HandlerContext) => AsyncIterable<unknown>;
		await collect(
			stream(create(EchoRequestSchema), contextFor(EchoService.method.watch)),
		);
		// Only the answers: the request side is on the timeline already.
		expect(timeline.frames().map((f) => f.kind)).toEqual([
			"message",
			"response",
			"message",
			"response",
		]);
	});

	it("records client streams and bidi streams as they are consumed", async () => {
		const { timeline, recorder, contextFor } = setup();
		const collectMethod = EchoService.method.collect;
		const summing = recordingImpl(
			collectMethod,
			(async (requests: AsyncIterable<{ text: string }>) => {
				let text = "";
				for await (const r of requests) text += r.text;
				return { text };
			}) as never,
			recorder,
		) as (r: AsyncIterable<unknown>, c: HandlerContext) => Promise<unknown>;
		await expect(
			summing(
				from([
					create(EchoRequestSchema, { text: "a" }),
					create(EchoRequestSchema, { text: "b" }),
				]),
				contextFor(collectMethod),
			),
		).resolves.toEqual({ text: "ab" });
		const failingCollect = recordingImpl(
			collectMethod,
			(async () => {
				throw new Error("no");
			}) as never,
			recorder,
		) as (r: AsyncIterable<unknown>, c: HandlerContext) => Promise<unknown>;
		await expect(
			failingCollect(from([]), contextFor(collectMethod)),
		).rejects.toThrow("no");

		const chat = EchoService.method.chat;
		const echoing = recordingImpl(
			chat,
			async function* (requests: AsyncIterable<{ text: string }>) {
				for await (const r of requests) yield { text: r.text.toUpperCase() };
			} as never,
			recorder,
		) as (
			r: AsyncIterable<unknown>,
			c: HandlerContext,
		) => AsyncIterable<unknown>;
		expect(
			await collect(
				echoing(
					from([create(EchoRequestSchema, { text: "x" })]),
					contextFor(chat),
				),
			),
		).toEqual([{ text: "X" }]);
		const failingChat = recordingImpl(
			chat,
			async function* () {
				yield* [];
				throw new Error("chat broke");
			} as never,
			recorder,
		) as (
			r: AsyncIterable<unknown>,
			c: HandlerContext,
		) => AsyncIterable<unknown>;
		await expect(
			collect(failingChat(from([]), contextFor(chat))),
		).rejects.toThrow("chat broke");
		expect(timeline.frames().map((f) => `${f.kind}:${f.direction}`)).toEqual([
			"request:out",
			"message:out",
			"message:in",
			"response:in",
			"response:in",
			"request:out",
			"message:in",
			"response:in",
			"response:in",
		]);
	});
});
