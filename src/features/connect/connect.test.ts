import { createServer, type Server } from "node:http";
import type { ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";

import { create, toBinary } from "@bufbuild/protobuf";
import {
	Code,
	ConnectError,
	createClient,
	type ServiceImpl,
} from "@connectrpc/connect";
import {
	connectNodeAdapter,
	createGrpcTransport,
	createConnectTransport as createNodeConnectTransport,
} from "@connectrpc/connect-node";
import {
	createConnectTransport,
	createGrpcWebTransport,
} from "@connectrpc/connect-web";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFakeContext,
	type FakeContext,
	type FakePage,
	FakeRequest,
} from "../../__fixtures__/fake-playwright.js";
import {
	EchoRequestSchema,
	EchoService,
} from "../../__fixtures__/gen/wirestage/test/v1/echo_pb.js";
import { named } from "../../entities/plugin/index.js";
import { createManualClock } from "../../shared/lib/clock/index.js";
import { encodeEnvelope } from "../../shared/lib/envelope/index.js";
import { createStage } from "../../widgets/stage/index.js";
import {
	type ConnectOptions,
	connect,
	createRpcClient,
	statusOf,
} from "./index.js";
import { collectResponse } from "./lib/universal.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The real backend a passthrough reaches: a plain Connect server, unrecorded. */
async function backend(
	impl: Partial<ServiceImpl<typeof EchoService>>,
	http2 = false,
) {
	const handler = connectNodeAdapter({
		routes: (router) => router.service(EchoService, impl),
	});
	const server: Server = http2
		? ((await import("node:http2")).createServer(handler) as unknown as Server)
		: createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	cleanups.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	return url;
}

const REAL: Partial<ServiceImpl<typeof EchoService>> = {
	say: (request) => ({ text: `real ${request.text}` }),
	async *watch(request) {
		yield { text: `real ${request.text}`, index: 1n };
	},
	peek: (request) => ({ text: `peeked ${request.text}` }),
};

async function setup(
	options: ConnectOptions = { baseURL: "/api" },
	extra: {
		clock?: ReturnType<typeof createManualClock>;
		network?: string;
		/** Runs before the stage is attached, for a test of attaching itself. */
		beforeAttach?: (
			attach: () => Promise<unknown>,
			context: FakeContext,
		) => Promise<void>;
	} = {},
) {
	const stage = createStage({
		plugins: [connect(options)],
		...(extra.clock === undefined ? {} : { clock: extra.clock }),
	});
	cleanups.push(() => stage.dispose());
	const context = createFakeContext();
	const attach = () => stage.attach(context, { baseURL: "http://app.test" });
	await extra.beforeAttach?.(attach, context);
	await attach();
	const page = context.newPage();
	const networkBase = extra.network ?? (await backend(REAL));
	const network = async (request: Request) => {
		const url = new URL(request.url);
		const body =
			request.method === "GET"
				? undefined
				: new Uint8Array(await request.arrayBuffer());
		return fetch(
			`${networkBase}${url.pathname.replace(/^\/api/, "")}${url.search}`,
			{
				method: request.method,
				headers: request.headers,
				...(body === undefined ? {} : { body }),
			},
		);
	};
	const fetcher = context.fetch({ network, page });
	const web = createClient(
		EchoService,
		createGrpcWebTransport({ baseUrl: "http://app.test/api", fetch: fetcher }),
	);
	const connectClient = createClient(
		EchoService,
		createConnectTransport({ baseUrl: "http://app.test/api", fetch: fetcher }),
	);
	const getClient = createClient(
		EchoService,
		createConnectTransport({
			baseUrl: "http://app.test/api",
			fetch: fetcher,
			useHttpGet: true,
		}),
	);
	return { stage, context, page, web, connectClient, getClient, networkBase };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const value of iterable) out.push(value);
	return out;
}

describe("unary stubs", () => {
	it("answers gRPC-web and Connect with a message or a function of the request", async () => {
		const { stage, web, connectClient } = await setup();
		const stub = await stage.connect.unary(
			EchoService.method.say,
			(request, context) => ({
				text: `stub ${request.text} ${context.requestHeader.get("x-tag") ?? ""}`.trim(),
			}),
		);
		await expect(
			web.say({ text: "a" }, { headers: { "x-tag": "t" } }),
		).resolves.toMatchObject({
			text: "stub a t",
		});
		await expect(connectClient.say({ text: "b" })).resolves.toMatchObject({
			text: "stub b",
		});
		expect(stub.hits).toBe(2);
		expect(stub.requests.map((r) => r.text)).toEqual(["a", "b"]);
		await expect(stub.next()).resolves.toMatchObject({ text: "a" });
		const calls = await stage.connect.calls(EchoService.method.say);
		expect(
			calls.map((c) => [
				c.protocol,
				c.caller,
				c.answeredBy,
				c.request?.text,
				c.responses[0]?.text,
				c.status?.code,
			]),
		).toEqual([
			["grpc-web", "page", "stub", "a", "stub a t", 0],
			["connect", "page", "stub", "b", "stub b", 0],
		]);
		// The request is the page's; the answer is the stub's.
		expect(calls[0]?.frames.map((f) => [f.kind, f.source])).toEqual([
			["request", "page"],
			["message", "stub"],
			["response", "stub"],
		]);
		expect(calls[0]?.frames[0]?.page).toBe("p1");
		const fixed = await stage.connect.unary(EchoService.method.say, {
			text: "fixed",
		});
		await expect(web.say({})).resolves.toMatchObject({ text: "fixed" });
		await fixed.remove();
		await stub.remove();
		await expect(web.say({ text: "c" })).resolves.toMatchObject({
			text: "real c",
		});
	});

	it("answers Connect GET requests", async () => {
		const { stage, getClient } = await setup();
		await stage.connect.unary(EchoService.method.peek, (request) => ({
			text: `got ${request.text}`,
		}));
		await expect(getClient.peek({ text: "q" })).resolves.toMatchObject({
			text: "got q",
		});
	});

	it("delays, limits by times and matches on the request", async () => {
		const clock = createManualClock();
		const { stage, web } = await setup({ baseURL: "/api" }, { clock });
		await stage.connect.unary(
			EchoService.method.say,
			{ text: "slow" },
			{ delayMs: 50 },
		);
		const answer = web.say({});
		await vi.waitFor(() => expect(clock.pending).toBe(1));
		await clock.advance(50);
		await expect(answer).resolves.toMatchObject({ text: "slow" });
		await stage.connect.unary(
			EchoService.method.say,
			{ text: "once" },
			{ times: 1 },
		);
		await expect(web.say({})).resolves.toMatchObject({ text: "once" });
		// Used up: the delayed stub below answers again, on the manual clock.
		const again = web.say({});
		await vi.waitFor(() => expect(clock.pending).toBe(1));
		await clock.advance(50);
		await expect(again).resolves.toMatchObject({ text: "slow" });
	});

	it("falls through for requests outside the base path, protocol or match", async () => {
		const { stage, context, web } = await setup({
			baseURL: "/api/",
			protocols: ["connect"],
		});
		await stage.connect.unary(
			EchoService.method.say,
			{ text: "connect only" },
			{
				match: (_request, view) => view.headers["x-vip"] !== "no",
			},
		);
		// gRPC-web is not among the protocols: the real backend answers.
		await expect(web.say({ text: "w" })).resolves.toMatchObject({
			text: "real w",
		});
		const elsewhere = await context.dispatch(
			"http://app.test/other/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/proto" },
			},
		);
		expect(elsewhere.outcome.kind).toBe("network");
		const refused = await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/proto", "x-vip": "no" },
			},
		);
		expect(refused.outcome.kind).toBe("network");
		const unknown = await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "text/plain" },
			},
		);
		expect(unknown.outcome.kind).toBe("network");
	});

	it("takes only requests the method can be called with", async () => {
		const { stage, context } = await setup();
		const say = await stage.connect.unary(EchoService.method.say, {
			text: "x",
		});
		const watch = await stage.connect.fail(
			EchoService.method.watch,
			Code.Unavailable,
		);
		const send = async (
			method: string,
			path: string,
			contentType?: string,
		): Promise<string> =>
			(
				await context.dispatch(
					`http://app.test/api/wirestage.test.v1.EchoService/${path}`,
					{
						method,
						...(contentType === undefined
							? {}
							: { headers: { "content-type": contentType } }),
					},
				)
			).outcome.kind;
		// Connect names a stream by its content type: not a unary method's.
		expect(await send("POST", "Say", "application/connect+proto")).toBe(
			"network",
		);
		// And the reverse: a unary content type is not a streaming method's.
		expect(await send("POST", "Watch", "application/proto")).toBe("network");
		// GET is for a method declared free of side effects, which Say is not.
		expect(await send("GET", "Say?connect=v1&encoding=proto&message=")).toBe(
			"network",
		);
		// No RPC is made with PUT.
		expect(await send("PUT", "Say", "application/proto")).toBe("network");
		expect([say.hits, watch.hits]).toEqual([0, 0]);
	});

	it("matches on the decoded request, and never on one that does not decode", async () => {
		const { stage, context, web } = await setup();
		const vip = await stage.connect.unary(
			EchoService.method.say,
			(request) => ({ text: `hello ${request.text}` }),
			{ match: (request) => request.text === "alice" },
		);
		await expect(web.say({ text: "alice" })).resolves.toMatchObject({
			text: "hello alice",
		});
		// Not the stub's: the real backend answers.
		await expect(web.say({ text: "bob" })).resolves.toMatchObject({
			text: "real bob",
		});
		const garbage = await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/proto" },
				body: new Uint8Array([0xff, 0xff, 0xff]),
			},
		);
		expect(garbage.outcome.kind).toBe("network");
		// An enveloped body with no message in it has nothing to match.
		const empty = await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/grpc-web+proto" },
				body: new Uint8Array(),
			},
		);
		expect(empty.outcome.kind).toBe("network");
		expect(vip.hits).toBe(1);
		// abort() reads no format of its own, so an unformatted request is
		// simply not its to match.
		await stage.connect.abort(EchoService.method.say, {
			match: (request) => request.text === "carol",
		});
		const plain = await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{ method: "POST", headers: { "content-type": "text/plain" } },
		);
		expect(plain.outcome.kind).toBe("network");
		await expect(web.say({ text: "carol" })).rejects.toBeInstanceOf(
			ConnectError,
		);
	});

	it("matches the method suffix under any prefix without a base path", async () => {
		const { stage, context } = await setup({});
		await stage.connect.unary(EchoService.method.say, { text: "anywhere" });
		const { outcome } = await context.dispatch(
			"http://app.test/deep/prefix/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/proto" },
				body: toBinary(EchoRequestSchema, create(EchoRequestSchema)),
			},
		);
		expect(outcome).toMatchObject({ kind: "fulfill", status: 200 });
	});
});

describe("service stubs and failures", () => {
	it("stubs the methods an implementation defines and passes the rest through", async () => {
		const { stage, web } = await setup();
		const handle = await stage.connect.service(EchoService, {
			say: () => ({ text: "from service" }),
			async *watch() {
				yield { text: "s1" };
				yield { text: "s2" };
			},
		});
		await expect(web.say({})).resolves.toMatchObject({ text: "from service" });
		expect((await collect(web.watch({}))).map((m) => m.text)).toEqual([
			"s1",
			"s2",
		]);
		await expect(web.peek({ text: "p" })).resolves.toMatchObject({
			text: "peeked p",
		});
		expect(handle.hits).toBe(2);
		await handle.remove();
		await expect(web.say({ text: "x" })).resolves.toMatchObject({
			text: "real x",
		});
		await expect(stage.connect.service(EchoService, {})).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
	});

	it("buffers finite streams when asked to", async () => {
		const { stage, web } = await setup({
			baseURL: "/api",
			streaming: "buffered",
		});
		await stage.connect.service(EchoService, {
			async *watch() {
				yield { text: "b1" };
				yield { text: "b2" };
			},
		});
		expect((await collect(web.watch({}))).map((m) => m.text)).toEqual([
			"b1",
			"b2",
		]);
		await expect(
			stage.connect.stream(EchoService.method.watch),
		).rejects.toMatchObject({ code: "UNSUPPORTED" });
	});

	it("fails unary and streaming calls with a status", async () => {
		const { stage, web } = await setup();
		await stage.connect.fail(
			EchoService.method.say,
			Code.PermissionDenied,
			"nope",
		);
		await stage.connect.fail(EchoService.method.watch, Code.Unavailable);
		await expect(web.say({})).rejects.toMatchObject({
			code: Code.PermissionDenied,
			rawMessage: "nope",
		});
		await expect(collect(web.watch({}))).rejects.toMatchObject({
			code: Code.Unavailable,
			rawMessage: "stubbed Unavailable",
		});
		const [failed] = await stage.connect.calls(EchoService.method.say);
		expect(failed?.status).toEqual({
			code: Code.PermissionDenied,
			message: "nope",
		});
	});

	it("aborts calls at the network level and records the fault", async () => {
		const { stage, web } = await setup();
		const handle = await stage.connect.abort(EchoService.method.say, {
			times: 1,
		});
		await expect(web.say({ text: "lost" })).rejects.toBeInstanceOf(
			ConnectError,
		);
		await expect(web.say({ text: "ok" })).resolves.toMatchObject({
			text: "real ok",
		});
		expect(handle.hits).toBe(1);
		await stage.connect.abort(EchoService.method.say, {
			error: "timedout",
			match: () => true,
		});
		await expect(web.say({})).rejects.toBeInstanceOf(ConnectError);
		const frames = (await stage.connect.calls(EchoService.method.say)).flatMap(
			(c) => c.frames,
		);
		expect(
			frames.filter((f) => f.kind === "fault").map((f) => f.meta["error"]),
		).toEqual(["failed", "timedout"]);
	});
});

describe("test-driven streams", () => {
	it("delivers messages as the test sends them, and ends cleanly", async () => {
		const { stage, web, connectClient } = await setup();
		const stub = await stage.connect.stream(EchoService.method.watch);
		const iterator = web.watch({ text: "open" })[Symbol.asyncIterator]();
		const first = iterator.next();
		const call = await stub.next();
		expect(call.request.text).toBe("open");
		expect(call.protocol).toBe("grpc-web");
		expect(call.requestHeaders.get("content-type")).toContain("grpc-web");
		await call.send({ text: "m1", index: 1n });
		await expect(first).resolves.toMatchObject({ value: { text: "m1" } });
		await call.send({ text: "m2", index: 2n });
		await expect(iterator.next()).resolves.toMatchObject({
			value: { text: "m2" },
		});
		await call.end();
		// Ended means over: the status is on the timeline by now.
		expect(
			(await stage.connect.calls(EchoService.method.watch))[0]?.status,
		).toEqual({ code: 0, message: "" });
		await expect(iterator.next()).resolves.toMatchObject({ done: true });
		await expect(call.closed).resolves.toBe("ended");
		await expect(call.send({})).rejects.toMatchObject({ code: "CLOSED" });
		const other = collect(connectClient.watch({}));
		const second = await stub.next();
		expect(second.protocol).toBe("connect");
		await stub.broadcast({ text: "all" });
		await second.end();
		expect((await other).map((m) => m.text)).toEqual(["all"]);
		expect(stub.calls).toHaveLength(2);
		expect(stub.hits).toBe(2);
		await stub.remove();
	});

	it("fails, cuts, and notices a client that went away", async () => {
		const { stage, web } = await setup();
		const stub = await stage.connect.stream(EchoService.method.watch);
		const failing = collect(web.watch({}));
		const failed = await stub.next();
		await failed.fail(Code.ResourceExhausted, "too many");
		await expect(failing).rejects.toMatchObject({
			code: Code.ResourceExhausted,
		});
		await expect(failed.closed).resolves.toBe("failed");
		await failed.fail(Code.Internal);

		const cutting = collect(web.watch({}));
		const cut = await stub.next();
		await cut.send({ text: "before the cut" });
		await cut.cut();
		await expect(cutting).rejects.toBeInstanceOf(ConnectError);
		await expect(cut.closed).resolves.toBe("cut");

		const abort = new AbortController();
		const leaving = collect(web.watch({}, { signal: abort.signal })).catch(
			(error: unknown) => error,
		);
		const left = await stub.next();
		abort.abort();
		await expect(left.closed).resolves.toBe("cancelled");
		await leaving;
		// Broadcasting skips calls that are gone.
		await stub.broadcast({ text: "nobody" });
		// Each ending is what the timeline says it was: a status for the one
		// that was given one, a fault for the two that were not.
		const calls = await stage.connect.calls(EchoService.method.watch);
		expect(calls.map((c) => [c.status?.code, c.fault])).toEqual([
			[Code.ResourceExhausted, undefined],
			[undefined, "cut"],
			[undefined, "cancelled"],
		]);
		// The stub cut the one; the page let go of the other.
		expect(calls.map((c) => c.frames.at(-1)?.source)).toEqual([
			"stub",
			"stub",
			"page",
		]);
	});

	it("records a cut as a fault however late it comes, never as an OK", async () => {
		const { stage, web } = await setup();
		const stub = await stage.connect.stream(EchoService.method.watch);
		const iterator = web.watch({ text: "late" })[Symbol.asyncIterator]();
		const reading = iterator.next();
		const call = await stub.next();
		// Resolves once written, so the page has it before the cut.
		await call.send({ text: "delivered" });
		await expect(reading).resolves.toMatchObject({
			value: { text: "delivered" },
		});
		// The implementation is idle now, and returns normally once cut.
		await call.cut();
		await expect(iterator.next()).rejects.toBeInstanceOf(ConnectError);
		const [cut] = await stage.connect.calls(EchoService.method.watch);
		expect(cut).toMatchObject({ status: undefined, fault: "cut" });
		expect(cut?.responses.map((m) => m.text)).toEqual(["delivered"]);
		// A message sent into a stream that is gone says so.
		await expect(call.send({ text: "lost" })).rejects.toMatchObject({
			code: "CLOSED",
		});
	});

	it("says so when a call matched but its stream never arrived", async () => {
		const { stage, context } = await setup();
		const stub = await stage.connect.stream(EchoService.method.watch);
		// Nothing called yet: a plain timeout.
		await expect(stub.next({ timeout: 5 })).rejects.toThrow(
			/^no wirestage\.test\.v1\.EchoService\/Watch stream arrived within 5 ms \(0 seen so far\)$/,
		);
		// The stub takes the call, but the redirect to the stream server is not
		// followed here — a page that cannot reach it looks the same.
		await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Watch",
			{
				method: "POST",
				headers: { "content-type": "application/grpc-web+proto" },
				body: encodeEnvelope(
					0,
					toBinary(EchoRequestSchema, create(EchoRequestSchema)),
				),
			},
		);
		await expect(stub.next({ timeout: 5 })).rejects.toThrow(
			/1 call\(s\) matched but never reached the local stream server/,
		);
	});
});

describe("holds", () => {
	it("releases, answers, fails or aborts each held call", async () => {
		const { stage, web } = await setup();
		const hold = await stage.connect.hold(EchoService.method.say);
		const released = web.say({ text: "r" });
		await (await hold.next()).release();
		await expect(released).resolves.toMatchObject({ text: "real r" });
		const answered = web.say({ text: "a" });
		const held = await hold.next();
		expect(held.request?.text).toBe("a");
		// A held call is on the timeline while it waits, unanswered.
		expect(
			(await stage.connect.calls(EchoService.method.say)).at(-1),
		).toMatchObject({ caller: "page", answeredBy: undefined });
		// Each decision resolves once it is carried out: the status is there.
		await held.reply({ text: "held reply" });
		expect(
			(await stage.connect.calls(EchoService.method.say)).at(-1)?.status,
		).toEqual({ code: 0, message: "" });
		// The first decision stands.
		await held.abort();
		await expect(answered).resolves.toMatchObject({ text: "held reply" });
		const failed = web.say({});
		await (await hold.next()).fail(Code.Aborted, "held failure");
		await expect(failed).rejects.toMatchObject({ code: Code.Aborted });
		const aborted = web.say({});
		await (await hold.next()).abort("connectionreset");
		await expect(aborted).rejects.toBeInstanceOf(ConnectError);
		const defaulted = web.say({});
		await (await hold.next()).abort();
		await expect(defaulted).rejects.toBeInstanceOf(ConnectError);
		expect(hold.calls).toHaveLength(5);
		expect(hold.hits).toBe(5);
		const calls = await stage.connect.calls(EchoService.method.say);
		expect(calls.map((c) => [c.answeredBy, c.status?.code, c.fault])).toEqual([
			["network", 0, undefined],
			["stub", 0, undefined],
			["stub", Code.Aborted, undefined],
			// An aborted call ended without a status, and says why.
			["stub", undefined, "abort"],
			["stub", undefined, "abort"],
		]);
		expect(calls.at(-2)?.frames.at(-1)?.meta).toMatchObject({
			reason: "abort",
			error: "connectionreset",
		});
		// Each request is on the timeline once, whoever answered it.
		expect(calls.map((c) => c.requests.length)).toEqual([1, 1, 1, 1, 1]);
	});

	it("lets every held call, and every later one, through on releaseAll", async () => {
		const { stage, page, web } = await setup();
		const hold = await stage.connect.hold(EchoService.method.say);
		const first = web.say({ text: "1" });
		const second = web.say({ text: "2" });
		await hold.next();
		await hold.next();
		await hold.releaseAll();
		await expect(first).resolves.toMatchObject({ text: "real 1" });
		await expect(second).resolves.toMatchObject({ text: "real 2" });
		// No longer holding: a later call goes straight through.
		await expect(web.say({ text: "3" })).resolves.toMatchObject({
			text: "real 3",
		});
		expect(hold.calls).toHaveLength(2);
		const [call] = await stage.connect.calls(EchoService.method.say);
		expect(call?.page).toBe(stage.pageId(page));
		expect(call?.context).toBe(stage.attachments[0]?.id);
	});

	it("does not hold a call that reaches the rule as releaseAll removes it", async () => {
		const { stage, context } = await setup();
		const hold = await stage.connect.hold(EchoService.method.say);
		// The router has picked the rule and is still reading the request's
		// headers when the test lets everything go.
		vi.spyOn(FakeRequest.prototype, "allHeaders").mockImplementationOnce(
			async function (this: FakeRequest) {
				await hold.releaseAll();
				return this.headers();
			},
		);
		const { outcome } = await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/proto" },
				body: toBinary(EchoRequestSchema, create(EchoRequestSchema)),
			},
		);
		expect(outcome.kind).toBe("network");
		expect(hold.calls).toEqual([]);
	});

	it("holds streams too, and lets go of pending holds on dispose", async () => {
		const { stage, web } = await setup({ baseURL: "/api" });
		const hold = await stage.connect.hold(EchoService.method.watch, {
			times: 3,
		});
		const streamed = collect(web.watch({}));
		(await hold.next()).reply({ text: "one message" });
		expect((await streamed).map((m) => m.text)).toEqual(["one message"]);
		const failing = collect(web.watch({}));
		(await hold.next()).fail(Code.NotFound);
		await expect(failing).rejects.toMatchObject({ code: Code.NotFound });
		const pending = web.say({}).catch((error: unknown) => error);
		const pendingStream = collect(web.watch({})).catch(
			(error: unknown) => error,
		);
		await hold.next();
		await stage.dispose();
		await expect(pendingStream).resolves.toBeInstanceOf(ConnectError);
		await expect(pending).resolves.toMatchObject({ text: "real " });
	});
});

describe("recording real traffic", () => {
	it("records from the next attach when the first one failed", async () => {
		const { stage, web } = await setup(
			{ baseURL: "/api", record: [EchoService] },
			{
				async beforeAttach(attach, context) {
					vi.spyOn(context, "route").mockRejectedValueOnce(
						new Error("context closed"),
					);
					await expect(attach()).rejects.toThrow("context closed");
				},
			},
		);
		await web.say({ text: "after a retry" });
		const [call] = await stage.connect.calls(EchoService.method.say);
		expect(call?.request?.text).toBe("after a retry");
	});

	it("decodes requests, responses and statuses that pass through", async () => {
		const { stage, web, connectClient } = await setup({
			baseURL: "/api",
			record: [EchoService],
		});
		await expect(web.say({ text: "recorded" })).resolves.toMatchObject({
			text: "real recorded",
		});
		await expect(connectClient.say({ text: "too" })).resolves.toMatchObject({
			text: "real too",
		});
		expect((await collect(web.watch({ text: "w" }))).length).toBe(1);
		// No waiting: a read brings the timeline up to date with the
		// responses that are already back.
		const says = await stage.connect.calls(EchoService.method.say);
		expect(
			says.map((c) => [
				c.caller,
				c.answeredBy,
				c.protocol,
				c.request?.text,
				c.responses[0]?.text,
				c.status,
			]),
		).toEqual([
			[
				"page",
				"network",
				"grpc-web",
				"recorded",
				"real recorded",
				{ code: 0, message: "" },
			],
			[
				"page",
				"network",
				"connect",
				"too",
				"real too",
				{ code: 0, message: "" },
			],
		]);
		const [watch] = await stage.connect.calls(EchoService.method.watch);
		expect(watch?.responses.map((m) => m.text)).toEqual(["real w"]);
		// A stubbed call is the stub's to record, and is recorded once.
		await stage.connect.unary(EchoService.method.say, { text: "stubbed" });
		await web.say({});
		const all = await stage.connect.calls(EchoService.method.say);
		expect(all).toHaveLength(3);
		expect(all.at(-1)?.answeredBy).toBe("stub");
		// A second context gets the recorder once, from its first attach.
		await stage.attach(createFakeContext());
	});

	it("records what will not decode, raw, instead of dropping it", async () => {
		const { stage, context } = await setup({
			baseURL: "/api",
			record: [EchoService],
		});
		await context.fetch({
			// Field 1, length 10, one byte of it: no decoder accepts that.
			network: async () =>
				new Response(new Uint8Array([0x0a, 0x0a, 0x41]), {
					status: 200,
					headers: { "content-type": "application/proto" },
				}),
		})("http://app.test/api/wirestage.test.v1.EchoService/Say", {
			method: "POST",
			headers: { "content-type": "application/proto" },
			body: new Uint8Array([0x0a, 0x0a, 0x41]),
		});
		// requestfinished is asynchronous, as it is in Playwright.
		await vi.waitFor(async () => {
			const frames =
				(await stage.connect.calls(EchoService.method.say))[0]?.frames ?? [];
			expect(
				frames
					.filter((f) => f.meta["decodeError"] !== undefined)
					.map((f) => f.direction),
			).toEqual(["out", "in"]);
			expect(frames.at(-1)?.meta).toMatchObject({ code: 0 });
		});
		// Truncated gRPC-web: no trailer, so the status says so.
		await context.fetch({
			network: async () =>
				new Response(new Uint8Array(encodeEnvelope(0, new Uint8Array(0))), {
					status: 200,
				}),
		})("http://app.test/api/wirestage.test.v1.EchoService/Watch", {
			method: "POST",
			headers: { "content-type": "application/grpc-web+proto" },
			body: new Uint8Array(encodeEnvelope(0, new Uint8Array(0))),
		});
		await vi.waitFor(async () => {
			const [watch] = await stage.connect.calls(EchoService.method.watch);
			expect(watch?.status).toEqual({
				code: Code.Internal,
				message: "missing trailer",
			});
		});
	});

	it("skips requests and responses with no RPC content type", async () => {
		const { stage } = await setup({ baseURL: "/api" });
		const handle = await stage.connect.record(EchoService);
		expect(handle.hits).toBe(0);
		await handle.remove();
	});

	it("records passthrough responses for a format-less request without crashing", async () => {
		const { stage, context } = await setup({ baseURL: "/api" });
		await stage.connect.record(EchoService);
		// No content type: the recorder declines (match), the request passes on.
		const { outcome } = await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
			},
		);
		expect(outcome.kind).toBe("network");
		expect(await stage.connect.calls(EchoService.method.say)).toEqual([]);
	});
});

describe("drive clients and served fakes", () => {
	it("closes a drive client's HTTP/2 connection with the stage", async () => {
		const server = (await import("node:http2")).createServer(
			connectNodeAdapter({
				routes: (router) => router.service(EchoService, REAL),
			}),
		);
		const sessions: ServerHttp2Session[] = [];
		server.on("session", (session) => sessions.push(session));
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		cleanups.push(
			() => new Promise<void>((resolve) => server.close(() => resolve())),
		);
		const stage = createStage({ plugins: [connect()] });
		cleanups.push(() => stage.dispose());
		const client = stage.connect.client(EchoService, {
			baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			protocol: "grpc",
			session: null,
		});
		await expect(client.say({ text: "x" })).resolves.toMatchObject({
			text: "real x",
		});
		const [session] = sessions;
		const closed = new Promise<void>((resolve) =>
			session?.once("close", () => resolve()),
		);
		// connect-node keeps an idle connection for 15 minutes, and the
		// server's close() above waits for it: on Node 22 it never returned.
		await stage.dispose();
		await closed;
	});

	it("calls the real backend as the page, over every protocol", async () => {
		const http1 = await backend(REAL);
		const http2 = await backend(REAL, true);
		const stage = createStage({
			plugins: [connect({ clientProtocol: "grpc-web" })],
			baseURL: "http://app.test",
		});
		cleanups.push(() => stage.dispose());
		const context: FakeContext = createFakeContext();
		context.cookieJar = [{ name: "session", value: "s1" }];
		await stage.attach(context);
		const seen: (string | null)[] = [];
		const spyBackend = createServer((request, response) => {
			seen.push(
				request.headers.cookie ?? null,
				String(request.headers["x-extra"] ?? ""),
			);
			connectNodeAdapter({
				routes: (router) => router.service(EchoService, REAL),
			})(request, response);
		});
		await new Promise<void>((resolve) =>
			spyBackend.listen(0, "127.0.0.1", resolve),
		);
		cleanups.push(
			() => new Promise<void>((resolve) => spyBackend.close(() => resolve())),
		);
		const spyUrl = `http://127.0.0.1:${(spyBackend.address() as AddressInfo).port}`;

		const defaults = stage.connect.client(EchoService, {
			baseURL: spyUrl,
			headers: { "x-extra": "1" },
		});
		await expect(defaults.say({ text: "a" })).resolves.toMatchObject({
			text: "real a",
		});
		await defaults.say({}, { headers: { cookie: "manual=1" } });
		const anonymous = stage.connect.client(EchoService, {
			baseURL: spyUrl,
			session: null,
			protocol: "connect",
			binary: false,
		});
		await anonymous.say({});
		const explicit = createFakeContext();
		explicit.cookieJar = [];
		await stage.connect
			.client(EchoService, { baseURL: spyUrl, session: explicit })
			.say({});
		// The page's cookie; a cookie the call set itself wins; none when asked.
		expect(seen).toEqual([
			"session=s1",
			"1",
			"manual=1",
			"1",
			null,
			"",
			null,
			"",
		]);

		const grpc = stage.connect.client(EchoService, {
			baseURL: http2,
			protocol: "grpc",
			ignoreHttpsErrors: true,
		});
		await expect(grpc.say({ text: "g" })).resolves.toMatchObject({
			text: "real g",
		});
		expect(
			(await collect(grpc.watch({ text: "s" }))).map((m) => m.text),
		).toEqual(["real s"]);
		const relative = stage.connect.client(EchoService, {
			baseURL: "/",
			protocol: "connect",
		});
		await expect(relative.say({})).rejects.toBeInstanceOf(ConnectError);
		const failing = stage.connect.client(EchoService, { baseURL: http1 });
		await expect(failing.peek({ text: "x" })).resolves.toMatchObject({
			text: "peeked x",
		});
		const calls = await stage.connect.calls(EchoService.method.say);
		// The test made the calls; the real backend answered them.
		expect(
			calls.every((c) => c.caller === "test" && c.answeredBy === "network"),
		).toBe(true);
		expect(calls[0]?.protocol).toBe("grpc-web");
		expect(calls[0]?.page).toBeUndefined();
	});

	it("keeps the cookies a response sets, so the next call carries them", async () => {
		const seen: (string | undefined)[] = [];
		const url = await backend({
			say: (request, handlerContext) => {
				seen.push(handlerContext.requestHeader.get("cookie") ?? undefined);
				if (request.text === "sign in") {
					handlerContext.responseHeader.append(
						"set-cookie",
						"sid=s2; Path=/; HttpOnly",
					);
					// No name: nothing a browser would keep.
					handlerContext.responseHeader.append("set-cookie", "=junk");
				}
				return { text: request.text };
			},
		});
		const signedIn = createFakeContext();
		const client = createRpcClient(EchoService, {
			baseURL: url,
			session: signedIn,
		});
		await client.say({ text: "sign in" });
		await client.say({ text: "as the session" });
		expect(seen).toEqual([undefined, "sid=s2"]);
		expect(signedIn.addedCookies).toEqual([
			{
				name: "sid",
				value: "s2",
				domain: "127.0.0.1",
				path: "/",
				httpOnly: true,
				secure: false,
			},
		]);
		// A context that cannot store cookies only lends its own.
		const readOnly = createFakeContext();
		delete (readOnly as { addCookies?: unknown }).addCookies;
		await createRpcClient(EchoService, { baseURL: url, session: readOnly }).say(
			{ text: "sign in" },
		);
		expect(readOnly.cookieJar).toEqual([]);
	});

	it("records failing drive calls and streams", async () => {
		const url = await backend({
			say: () => {
				throw new ConnectError("backend says no", Code.FailedPrecondition);
			},
			async *watch() {
				yield { text: "partial" };
				throw new ConnectError("mid-stream", Code.DataLoss);
			},
		});
		const stage = createStage({ plugins: [connect()] });
		cleanups.push(() => stage.dispose());
		const client = stage.connect.client(EchoService, { baseURL: url });
		await expect(client.say({})).rejects.toMatchObject({
			code: Code.FailedPrecondition,
		});
		await expect(collect(client.watch({}))).rejects.toMatchObject({
			code: Code.DataLoss,
		});
		const [say] = await stage.connect.calls(EchoService.method.say);
		const [watch] = await stage.connect.calls(EchoService.method.watch);
		expect(say?.status?.code).toBe(Code.FailedPrecondition);
		expect(watch?.responses.map((m) => m.text)).toEqual(["partial"]);
		expect(watch?.status?.code).toBe(Code.DataLoss);
	});

	it("needs an absolute base URL when the stage has none", () => {
		const stage = createStage({ plugins: [connect()] });
		cleanups.push(() => stage.dispose());
		expect(() => stage.connect.client(EchoService)).toThrow(
			/is relative and the stage has no baseURL/,
		);
		expect(() =>
			stage.connect.client(EchoService, { baseURL: "http://h" }),
		).not.toThrow();
	});

	it("drives a backend without a stage", async () => {
		const url = await backend(REAL);
		const session = createFakeContext();
		session.cookieJar = [{ name: "a", value: "b" }];
		const client = createRpcClient(EchoService, {
			baseURL: url,
			protocol: "grpc-web",
			session,
		});
		await expect(client.say({ text: "solo" })).resolves.toMatchObject({
			text: "real solo",
		});
		const bare = createRpcClient(EchoService, { baseURL: url });
		await expect(bare.say({ text: "bare" })).resolves.toMatchObject({
			text: "real bare",
		});
		expect(session.cookieRequests.length).toBe(1);
	});

	it("serves recorded fakes for clients outside the browser, over HTTP/2 and 1.1", async () => {
		const stage = createStage({ plugins: [connect()] });
		cleanups.push(() => stage.dispose());
		let handlers = 0;
		const grpcServer = await stage.connect.serve((router) => {
			router
				.service(EchoService, {
					say: (request) => ({ text: `served ${request.text}` }),
					async collect(requests) {
						let text = "";
						for await (const request of requests) text += request.text;
						return { text };
					},
					async *chat(requests) {
						for await (const request of requests)
							yield { text: request.text.toUpperCase() };
					},
				})
				.rpc(EchoService.method.peek, (request) => ({
					text: `peek ${request.text}`,
				}));
			handlers = router.handlers.length;
		});
		// Connect registers every method of a service (unimplemented ones
		// answer Unimplemented), plus the separate rpc.
		expect(handlers).toBe(6);
		const grpc = createClient(
			EchoService,
			createGrpcTransport({ baseUrl: grpcServer.url }),
		);
		await expect(grpc.say({ text: "x" })).resolves.toMatchObject({
			text: "served x",
		});
		await expect(grpc.peek({ text: "y" })).resolves.toMatchObject({
			text: "peek y",
		});
		async function* requests() {
			yield create(EchoRequestSchema, { text: "a" });
			yield create(EchoRequestSchema, { text: "b" });
		}
		await expect(grpc.collect(requests())).resolves.toMatchObject({
			text: "ab",
		});
		expect((await collect(grpc.chat(requests()))).map((m) => m.text)).toEqual([
			"A",
			"B",
		]);
		const [served] = await stage.connect.calls(EchoService.method.say);
		// A client outside the browser called; the served fake answered.
		expect(served).toMatchObject({
			caller: "network",
			answeredBy: "server",
			protocol: "grpc",
		});

		const webServer = await stage.connect.serve(
			(router) =>
				router.service(EchoService, { say: () => ({ text: "over 1.1" }) }),
			{ protocols: ["grpc-web", "connect"] },
		);
		const web = createClient(
			EchoService,
			createGrpcWebTransport({ baseUrl: webServer.url }),
		);
		await expect(web.say({})).resolves.toMatchObject({ text: "over 1.1" });
		await webServer.close();
		const held = await stage.connect.serve(
			(router) => router.service(EchoService, REAL),
			{ http2: false, port: 0 },
		);
		expect(held.port).toBeGreaterThan(0);
		// Dispose closes what the test did not.
	});
});

describe("route.fulfill limits", () => {
	it("refuses a response that needs HTTP trailers", async () => {
		await expect(
			collectResponse({
				status: 200,
				header: new Headers(),
				body: undefined,
				trailer: new Headers({ "grpc-status": "0" }),
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED" });
		await expect(collectResponse({ status: 204 })).resolves.toEqual({
			status: 204,
			headers: {},
			body: new Uint8Array(0),
		});
	});

	it("answers 500 when a native gRPC request reaches a route stub", async () => {
		const { stage, context } = await setup({
			baseURL: "/api",
			protocols: ["grpc"],
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await stage.connect.unary(EchoService.method.say, { text: "x" });
		const { outcome } = await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/grpc", te: "trailers" },
				body: encodeEnvelope(
					0,
					toBinary(EchoRequestSchema, create(EchoRequestSchema)),
				),
			},
		);
		expect(outcome).toMatchObject({ kind: "fulfill", status: 500 });
	});
});

describe("pages", () => {
	it("tags stubbed calls with the page that made them", async () => {
		const { stage, web, page } = await setup();
		await stage.connect.unary(EchoService.method.say, { text: "x" });
		await web.say({});
		const [call] = await stage.connect.calls(EchoService.method.say);
		expect(
			call?.frames.every((f) => f.page === stage.pageId(page as FakePage)),
		).toBe(true);
	});
});

describe("edges", () => {
	it("honours JSON options for JSON clients", async () => {
		const { stage, context, page } = await setup({
			baseURL: "/api",
			jsonOptions: { ignoreUnknownFields: true },
		});
		await stage.connect.unary(EchoService.method.say, (request) => ({
			text: `json ${request.text}`,
		}));
		const json = createClient(
			EchoService,
			createConnectTransport({
				baseUrl: "http://app.test/api",
				fetch: context.fetch({ page }),
				useBinaryFormat: false,
			}),
		);
		await expect(json.say({ text: "j" })).resolves.toMatchObject({
			text: "json j",
		});
	});

	it("leaves a request that is not an RPC alone, and aborts a service worker's call", async () => {
		const { stage, context } = await setup();
		await stage.connect.abort(EchoService.method.say);
		const url = "http://app.test/api/wirestage.test.v1.EchoService/Say";
		// Something else at the method's path: not a call, so not the stub's.
		const plain = await context.dispatch(url, { method: "POST" });
		expect(plain.outcome).toEqual({ kind: "network" });
		expect(await stage.connect.calls(EchoService.method.say)).toEqual([]);
		// A call from a service worker has no page, and is aborted all the same.
		const { outcome } = await context.dispatch(url, {
			method: "POST",
			headers: { "content-type": "application/proto" },
			body: toBinary(EchoRequestSchema, create(EchoRequestSchema)),
			frameless: true,
		});
		expect(outcome).toEqual({ kind: "abort", error: "failed" });
		const [call] = await stage.connect.calls(EchoService.method.say);
		expect(call?.frames.map((f) => f.kind)).toEqual(["request", "fault"]);
		expect(call).toMatchObject({ fault: "abort", status: undefined });
		expect(call?.page).toBeUndefined();
	});

	it("groups frames another writer left without a correlation, one call each", async () => {
		const stage = createStage({ plugins: [connect()] });
		cleanups.push(() => stage.dispose());
		const endpoint = "wirestage.test.v1.EchoService/Say";
		stage.timeline.append({
			protocol: "connect",
			kind: "request",
			direction: "out",
			endpoint,
			source: "test",
		});
		stage.timeline.append({
			protocol: "connect",
			kind: "response",
			direction: "in",
			endpoint,
			source: "test",
			meta: { code: 5 },
		});
		const calls = await stage.connect.calls(EchoService.method.say);
		expect(calls.map((c) => [c.correlation, c.status])).toEqual([
			["#1", undefined],
			["#2", { code: 5, message: "" }],
		]);
		// With no decoded request there is no saying who called.
		expect(calls.map((c) => [c.caller, c.answeredBy])).toEqual([
			[undefined, undefined],
			[undefined, "test"],
		]);
	});

	it("serves Connect GET requests, which carry no content type", async () => {
		const stage = createStage({ plugins: [connect()] });
		cleanups.push(() => stage.dispose());
		const server = await stage.connect.serve(
			(router) =>
				router.rpc(EchoService.method.peek, (request) => ({
					text: `get ${request.text}`,
				})),
			{ protocols: ["connect"] },
		);
		const client = createClient(
			EchoService,
			createNodeConnectTransport({
				baseUrl: server.url,
				httpVersion: "1.1",
				useHttpGet: true,
			}),
		);
		await expect(client.peek({ text: "g" })).resolves.toMatchObject({
			text: "get g",
		});
		const [call] = await stage.connect.calls(EchoService.method.peek);
		expect(call?.protocol).toBe("connect");
	});
});

describe("one call, however many rules see it", () => {
	const sayUrl = "http://app.test/api/wirestage.test.v1.EchoService/Say";
	const sayBody = () => ({
		method: "POST",
		headers: { "content-type": "application/proto" },
		body: toBinary(EchoRequestSchema, create(EchoRequestSchema, { text: "x" })),
	});

	it("records one call when a recorder sits above the stub that answers", async () => {
		const { stage, web } = await setup();
		await stage.connect.unary(EchoService.method.say, { text: "stubbed" });
		// Added later, so it sees the call first, and passes it on.
		const recorder = await stage.connect.record(EchoService);
		await expect(web.say({ text: "x" })).resolves.toMatchObject({
			text: "stubbed",
		});
		expect(recorder.hits).toBe(1);
		const calls = await stage.connect.calls(EchoService.method.say);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			caller: "page",
			answeredBy: "stub",
			status: { code: 0 },
		});
		// One request frame, not one per rule that saw it.
		expect(calls[0]?.requests).toHaveLength(1);
		expect(calls[0]?.responses.map((m) => m.text)).toEqual(["stubbed"]);
	});

	it("records one call when a held call goes on to a recorded backend", async () => {
		const { stage, web } = await setup({
			baseURL: "/api",
			record: [EchoService],
		});
		const hold = await stage.connect.hold(EchoService.method.say);
		const pending = web.say({ text: "backend" });
		await (await hold.next()).release();
		await expect(pending).resolves.toMatchObject({ text: "real backend" });
		const calls = await stage.connect.calls(EchoService.method.say);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			answeredBy: "network",
			status: { code: 0, message: "" },
		});
		expect(calls[0]?.requests).toHaveLength(1);
	});

	it("records a recorded call that fails on the network as a fault", async () => {
		const { stage, context } = await setup({
			baseURL: "/api",
			record: [EchoService],
		});
		const { request } = await context.dispatch(sayUrl, sayBody());
		request.failureText = "net::ERR_CONNECTION_REFUSED";
		context.emit("requestfailed", request);
		const [call] = await stage.connect.calls(EchoService.method.say);
		// Not "still open": it ended, without a status, and says why.
		expect(call).toMatchObject({
			caller: "page",
			answeredBy: "network",
			status: undefined,
			fault: "network",
		});
		expect(call?.frames.at(-1)?.meta).toMatchObject({
			reason: "network",
			error: "net::ERR_CONNECTION_REFUSED",
		});
	});

	it("records the status the page saw when a stub throws a plain error", async () => {
		const { stage, web } = await setup();
		await stage.connect.unary(EchoService.method.say, () => {
			throw new Error("bug in the stub");
		});
		await expect(web.say({})).rejects.toMatchObject({
			code: Code.Internal,
			rawMessage: "internal error",
		});
		const [call] = await stage.connect.calls(EchoService.method.say);
		expect(call?.status).toEqual({
			code: Code.Internal,
			message: "internal error",
		});
		// What was really thrown is on the frame, for the test to read.
		expect(call?.frames.at(-1)?.meta["thrown"]).toBe("Error: bug in the stub");
	});
});

describe("every stub means the same by a call", () => {
	it("delays streaming stubs, failures and aborts as it does unary ones", async () => {
		const clock = createManualClock();
		const { stage, web } = await setup({ baseURL: "/api" }, { clock });
		const stub = await stage.connect.stream(EchoService.method.watch, {
			delayMs: 30,
		});
		const reading = collect(web.watch({ text: "x" }));
		await vi.waitFor(() => expect(clock.pending).toBe(1));
		// The call is on the timeline from the moment it arrived...
		expect(
			(await stage.connect.calls(EchoService.method.watch))[0]?.request?.text,
		).toBe("x");
		// ...and is answered only once the delay has passed.
		expect(stub.calls).toHaveLength(0);
		await clock.advance(30);
		const call = await stub.next();
		await call.send({ text: "after the delay" });
		await call.end();
		expect((await reading).map((m) => m.text)).toEqual(["after the delay"]);
		await stub.remove();

		await stage.connect.fail(EchoService.method.watch, Code.Unavailable, "", {
			delayMs: 10,
		});
		const failing = collect(web.watch({})).catch((error: unknown) => error);
		await vi.waitFor(() => expect(clock.pending).toBe(1));
		await clock.advance(10);
		await expect(failing).resolves.toMatchObject({ code: Code.Unavailable });

		await stage.connect.abort(EchoService.method.say, { delayMs: 20 });
		const aborted = web.say({}).catch((error: unknown) => error);
		await vi.waitFor(() => expect(clock.pending).toBe(1));
		await clock.advance(20);
		await expect(aborted).resolves.toBeInstanceOf(ConnectError);
	});

	it("lets a call in a protocol it was not given pass every kind of stub by", async () => {
		const { stage, web, connectClient } = await setup({
			baseURL: "/api",
			protocols: ["connect"],
		});
		await stage.connect.abort(EchoService.method.say);
		const hold = await stage.connect.hold(EchoService.method.peek);
		// gRPC-web is not among the protocols: neither stub is its to take.
		await expect(web.say({ text: "w" })).resolves.toMatchObject({
			text: "real w",
		});
		await expect(web.peek({ text: "p" })).resolves.toMatchObject({
			text: "peeked p",
		});
		expect(hold.calls).toHaveLength(0);
		await expect(connectClient.say({})).rejects.toBeInstanceOf(ConnectError);
	});

	it("leaves gRPC-web-text to the backend, and still records it", async () => {
		const { stage, context } = await setup({
			baseURL: "/api",
			record: [EchoService],
		});
		const stub = await stage.connect.unary(EchoService.method.say, {
			text: "stub",
		});
		// Connect's handlers do not speak the base64 form: a stub that took the
		// call could only answer 415.
		const { outcome } = await context.dispatch(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/grpc-web-text" },
				body: Buffer.from(
					encodeEnvelope(
						0,
						toBinary(
							EchoRequestSchema,
							create(EchoRequestSchema, { text: "as text" }),
						),
					),
				).toString("base64"),
			},
		);
		expect(outcome.kind).toBe("network");
		expect(stub.hits).toBe(0);
		const [call] = await stage.connect.calls(EchoService.method.say);
		expect(call).toMatchObject({ protocol: "grpc-web" });
		expect(call?.request?.text).toBe("as text");
	});

	it("matches an absolute base URL by origin and path", async () => {
		const { stage, context, web } = await setup({
			baseURL: "http://app.test/api/",
		});
		await stage.connect.unary(EchoService.method.say, { text: "absolute" });
		await expect(web.say({})).resolves.toMatchObject({ text: "absolute" });
		const elsewhere = await context.dispatch(
			"http://other.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/proto" },
			},
		);
		expect(elsewhere.outcome.kind).toBe("network");
	});

	it("refuses to stub a method a page cannot call", async () => {
		const { stage, web } = await setup();
		await expect(
			stage.connect.fail(EchoService.method.chat, Code.Internal),
		).rejects.toMatchObject({
			code: "UNSUPPORTED",
			message: expect.stringContaining("bidi-streaming"),
		});
		await expect(
			stage.connect.abort(EchoService.method.collect),
		).rejects.toMatchObject({
			code: "UNSUPPORTED",
			message: expect.stringContaining("client-streaming"),
		});
		// A service stub is all of what it was given, or none of it.
		await expect(
			stage.connect.service(EchoService, {
				say: () => ({ text: "would answer" }),
				async collect() {
					return { text: "" };
				},
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED" });
		await expect(web.say({ text: "x" })).resolves.toMatchObject({
			text: "real x",
		});
	});

	it("calls a service's methods on the object they came from", async () => {
		class Greeter {
			greeting = "hello";
			say(request: { text: string }) {
				return { text: `${this.greeting} ${request.text}` };
			}
		}
		const { stage, web } = await setup();
		await stage.connect.service(EchoService, new Greeter());
		await expect(web.say({ text: "page" })).resolves.toMatchObject({
			text: "hello page",
		});
		const server = await stage.connect.serve(
			(router) => router.service(EchoService, new Greeter()),
			{ protocols: ["connect"] },
		);
		const outside = createClient(
			EchoService,
			createNodeConnectTransport({ baseUrl: server.url, httpVersion: "1.1" }),
		);
		await expect(outside.say({ text: "outside" })).resolves.toMatchObject({
			text: "hello outside",
		});
	});

	it("delivers every cookie a stub sets, not only the last", async () => {
		const { stage, context, page } = await setup();
		await stage.connect.unary(EchoService.method.say, (_request, handler) => {
			handler.responseHeader.append("set-cookie", "a=1; Path=/");
			handler.responseHeader.append("set-cookie", "b=2; Path=/");
			return { text: "signed in" };
		});
		const response = await context.fetch({ page })(
			"http://app.test/api/wirestage.test.v1.EchoService/Say",
			{
				method: "POST",
				headers: { "content-type": "application/proto" },
				body: toBinary(EchoRequestSchema, create(EchoRequestSchema)),
			},
		);
		expect(response.headers.getSetCookie()).toEqual([
			"a=1; Path=/",
			"b=2; Path=/",
		]);
	});

	it("runs twice under two names, each with its own stubs and calls", async () => {
		const stage = createStage({
			plugins: [
				connect({ baseURL: "/api" }),
				named("billing", connect({ baseURL: "/billing" })),
			],
		});
		cleanups.push(() => stage.dispose());
		const context = createFakeContext();
		await stage.attach(context, { baseURL: "http://app.test" });
		await stage.connect.unary(EchoService.method.say, { text: "the api" });
		await stage.billing.unary(EchoService.method.say, { text: "billing" });
		const call = async (prefix: string) => {
			const { outcome } = await context.dispatch(
				`http://app.test${prefix}/wirestage.test.v1.EchoService/Say`,
				{
					method: "POST",
					headers: { "content-type": "application/proto" },
					body: toBinary(EchoRequestSchema, create(EchoRequestSchema)),
				},
			);
			return outcome.kind;
		};
		expect(await call("/api")).toBe("fulfill");
		expect(await call("/billing")).toBe("fulfill");
		expect(await call("/billing")).toBe("fulfill");
		expect(await stage.connect.calls(EchoService.method.say)).toHaveLength(1);
		const billing = await stage.billing.calls(EchoService.method.say);
		expect(billing.map((c) => c.responses[0]?.text)).toEqual([
			"billing",
			"billing",
		]);
		expect(billing[0]?.frames[0]?.protocol).toBe("billing");
	});
});

describe("a drive client's session", () => {
	it("sends its default headers only where the call set none", async () => {
		const url = await backend({
			say: (_request, handler) => ({
				text: handler.requestHeader.get("x-tag") ?? "",
			}),
		});
		const client = createRpcClient(EchoService, {
			baseURL: url,
			headers: { "x-tag": "default" },
		});
		expect((await client.say({})).text).toBe("default");
		expect(
			(await client.say({}, { headers: { "x-tag": "this call" } })).text,
		).toBe("this call");
	});

	it("keeps the cookies an error response sets, as a sign-out does", async () => {
		const url = await backend({
			say: () => {
				throw new ConnectError("signed out", Code.Unauthenticated, {
					"set-cookie": "sid=; Max-Age=0; Path=/",
				});
			},
		});
		const session = createFakeContext();
		session.cookieJar = [
			{ name: "sid", value: "s1", domain: "127.0.0.1", path: "/" },
		];
		const client = createRpcClient(EchoService, { baseURL: url, session });
		await expect(client.say({})).rejects.toMatchObject({
			code: Code.Unauthenticated,
		});
		expect(session.addedCookies).toMatchObject([
			{ name: "sid", value: "", domain: "127.0.0.1" },
		]);
		// An error that is not the server's own carries no cookies to keep.
		const unreachable = createRpcClient(EchoService, {
			baseURL: "http://127.0.0.1:1",
			session,
		});
		await expect(unreachable.say({})).rejects.toBeInstanceOf(ConnectError);
		expect(session.addedCookies).toHaveLength(1);
	});

	it("scopes cookies to the host the request names, not the address it went to", async () => {
		const seen: (string | null)[] = [];
		const url = await backend({
			say: (_request, handler) => {
				seen.push(handler.requestHeader.get("cookie"));
				handler.responseHeader.append("set-cookie", "team=1; Path=/");
				return { text: "ok" };
			},
		});
		const session = createFakeContext();
		session.cookieJar = [
			{ name: "sid", value: "team-user", domain: "team.localhost", path: "/" },
			{ name: "sid", value: "someone-else", domain: "127.0.0.1", path: "/" },
		];
		// One server, several sites by Host: the session is the named site's.
		const client = createRpcClient(EchoService, {
			baseURL: url,
			session,
			headers: { host: "team.localhost" },
		});
		await client.say({});
		expect(seen).toEqual(["sid=team-user"]);
		expect(session.addedCookies).toMatchObject([
			{ name: "team", value: "1", domain: "team.localhost" },
		]);
	});

	it("stamps a cookie's expiry by the stage's clock", async () => {
		const url = await backend({
			say: (_request, handler) => {
				handler.responseHeader.append("set-cookie", "sid=1; Max-Age=60");
				return { text: "ok" };
			},
		});
		const clock = createManualClock(1_000_000);
		const stage = createStage({ plugins: [connect()], clock });
		cleanups.push(() => stage.dispose());
		const session = createFakeContext();
		await stage.attach(session);
		await stage.connect.client(EchoService, { baseURL: url }).say({});
		expect(session.addedCookies[0]?.expires).toBe(1_000 + 60);
	});
});

describe("statusOf", () => {
	it("reads 0 for a call that resolved and the code for one that failed", async () => {
		expect(await statusOf(Promise.resolve({}))).toBe(0);
		expect(
			await statusOf(
				Promise.reject(new ConnectError("no", Code.PermissionDenied)),
			),
		).toBe(Code.PermissionDenied);
	});

	it("rethrows what is not a status", async () => {
		await expect(
			statusOf(Promise.reject(new TypeError("bug"))),
		).rejects.toThrow("bug");
	});
});
