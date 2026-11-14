import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFakeContext,
	fakeResponse,
} from "../../../__fixtures__/fake-playwright.js";
import {
	type Attachment,
	definePlugin,
	type PluginContext,
	type PluginRuntime,
} from "../../../entities/plugin/index.js";
import { createManualClock } from "../../../shared/lib/clock/index.js";
import { createStage } from "./create-stage.js";

afterEach(() => vi.restoreAllMocks());

interface ProbeFailures {
	attach?: boolean;
	detach?: boolean;
	dispose?: boolean;
}

function probe<const Name extends string = "probe">(
	name: Name = "probe" as Name,
	fail: ProbeFailures = {},
	calls: string[] = [],
) {
	let captured: PluginContext | undefined;
	const plugin = definePlugin({
		name,
		setup(context) {
			captured = context;
			return {
				api: { hello: () => `hello from ${name}` },
				attach: (a: Attachment) => {
					calls.push(`${name} attach ${a.id}`);
					if (fail.attach) throw new Error(`${name} cannot attach`);
				},
				detach: (a: Attachment) => {
					calls.push(`${name} detach ${a.id}`);
					if (fail.detach) throw new Error(`${name} cannot detach`);
				},
				dispose: () => {
					calls.push(`${name} dispose`);
					if (fail.dispose) throw new Error(`${name} cannot dispose`);
				},
			} satisfies PluginRuntime<unknown>;
		},
	});
	return {
		plugin,
		calls,
		context: () => captured as PluginContext,
	};
}

const marker = (name: string) => ({ kind: "marker" as const, endpoint: name });

const append = (
	stage: { timeline: PluginContext["timeline"] },
	endpoint: string,
) =>
	stage.timeline.append({
		protocol: "rest",
		kind: "request",
		direction: "out",
		endpoint,
		source: "page",
	});

describe("createStage", () => {
	it("mounts each plugin's API under its name and hands it the services", () => {
		const { plugin, context } = probe();
		const stage = createStage({
			plugins: [plugin],
			baseURL: "http://app.test",
		});
		expect(stage.probe.hello()).toBe("hello from probe");
		const services = context();
		expect(services.timeline).toBe(stage.timeline);
		expect(services.baseURL).toBe("http://app.test");
		expect(services.attachments()).toEqual([]);
		expect(typeof services.http.add).toBe("function");
		expect(typeof services.sockets.add).toBe("function");
		expect(typeof services.pages.register).toBe("function");
		expect(stage.disposed).toBe(false);
	});

	it("refuses a reserved or repeated plugin name", () => {
		expect(() => createStage({ plugins: [probe("frames").plugin] })).toThrow(
			/"frames" is reserved/,
		);
		expect(() =>
			createStage({ plugins: [probe("a").plugin, probe("a").plugin] }),
		).toThrow(/two plugins are named "a"/);
	});

	it("attaches and detaches contexts, telling every plugin", async () => {
		const { plugin, calls, context } = probe();
		const stage = createStage({ plugins: [plugin] });
		const first = createFakeContext();
		const second = createFakeContext();
		const detachFirst = await stage.attach(first, {
			baseURL: "http://one.test",
		});
		await stage.attach(second);
		expect(stage.attachments.map((a) => [a.id, a.baseURL])).toEqual([
			["c1", "http://one.test"],
			["c2", undefined],
		]);
		// What a plugin is given of a context: its id, its base URL, its jar.
		expect(context().attachments()[0]?.cookies).toBe(first);
		await expect(stage.attach(first)).rejects.toThrow(/already attached/);
		await detachFirst();
		await detachFirst();
		await stage.detach(createFakeContext());
		await stage.detach();
		expect(calls).toEqual([
			"probe attach c1",
			"probe attach c2",
			"probe detach c1",
			"probe detach c2",
		]);
		expect(stage.attachments).toEqual([]);
	});

	it("detaches a context that closes on its own", async () => {
		const { plugin, calls } = probe();
		const stage = createStage({ plugins: [plugin] });
		const context = createFakeContext();
		await stage.attach(context);
		context.emit("close");
		await vi.waitFor(() => expect(calls).toContain("probe detach c1"));
		await stage.detach(context);
	});

	it("does not let a plugin that fails on a closed context surface as a stray rejection", async () => {
		const { plugin } = probe("probe", { detach: true });
		const stage = createStage({ plugins: [plugin] });
		const context = createFakeContext();
		await stage.attach(context);
		const unhandled = vi.fn();
		process.once("unhandledRejection", unhandled);
		context.emit("close");
		await new Promise((resolve) => setTimeout(resolve, 5));
		process.off("unhandledRejection", unhandled);
		expect(unhandled).not.toHaveBeenCalled();
		expect(stage.attachments).toEqual([]);
	});

	it("disposes once, after which it cannot attach", async () => {
		const { plugin, calls } = probe();
		const stage = createStage({ plugins: [plugin] });
		await stage.attach(createFakeContext());
		await stage.dispose();
		await stage.dispose();
		expect(stage.disposed).toBe(true);
		expect(calls).toEqual([
			"probe attach c1",
			"probe detach c1",
			"probe dispose",
		]);
		await expect(stage.attach(createFakeContext())).rejects.toMatchObject({
			code: "INVALID_STATE",
		});
	});

	it("gives a scopeless plugin the Plugin logger and wires waitFor and sync", async () => {
		const { plugin, context } = probe();
		const stage = createStage({ plugins: [plugin] });
		await context().sync();
		stage.timeline.append({
			protocol: "x",
			kind: "event",
			direction: "in",
			endpoint: "e",
			source: "stub",
		});
		await expect(context().waitFor({ protocol: "x" })).resolves.toHaveLength(1);
		expect(typeof context().log.info).toBe("function");
	});
});

describe("createStage: failures leave nothing behind", () => {
	it("undoes a failed attach, so the context can be attached again", async () => {
		const calls: string[] = [];
		const first = probe("first", {}, calls);
		const failing = probe("failing", { attach: true }, calls);
		const never = probe("never", {}, calls);
		const stage = createStage({
			plugins: [first.plugin, failing.plugin, never.plugin],
		});
		// A rule that exists before the attach puts a route into the context.
		await first.context().http.add({
			protocol: "http",
			label: "rule",
			url: "/api/**",
			handle: () => ({ type: "fulfill" }),
		});
		const context = createFakeContext();
		await expect(stage.attach(context)).rejects.toThrow(
			"failing cannot attach",
		);
		// Undone in reverse, and only for the plugins whose attach was started.
		expect(calls).toEqual([
			"first attach c1",
			"failing attach c1",
			"failing detach c1",
			"first detach c1",
		]);
		expect(stage.attachments).toEqual([]);
		expect(context.routeCount).toBe(0);
		// Not stuck as "already attached": the caller may fix the cause and retry.
		await expect(stage.attach(context)).rejects.toThrow(
			"failing cannot attach",
		);
		await stage.dispose();
	});

	it("undoes an attach the browser refused", async () => {
		const stage = createStage({ plugins: [probe().plugin] });
		// A page module makes the stage expose a binding, which this context refuses.
		const pages = createStage({
			plugins: [
				definePlugin({
					name: "paged",
					setup(context) {
						context.pages.register({
							id: "paged",
							install: () => {},
							config: null,
							state: () => null,
							receive: () => {},
						});
						return { api: {} };
					},
				}),
			],
		});
		const context = createFakeContext();
		vi.spyOn(context, "exposeBinding").mockRejectedValueOnce(
			new Error("context closed"),
		);
		await expect(pages.attach(context)).rejects.toThrow("context closed");
		expect(pages.attachments).toEqual([]);
		await expect(pages.attach(context)).resolves.toBeTypeOf("function");
		await pages.dispose();
		await stage.dispose();
	});

	it("still reports a failed attach when undoing it fails too", async () => {
		const { plugin } = probe("probe", { attach: true, detach: true });
		const stage = createStage({ plugins: [plugin] });
		await expect(stage.attach(createFakeContext())).rejects.toThrow(
			"probe cannot attach",
		);
		expect(stage.attachments).toEqual([]);
	});

	it("detaches the engines even when a plugin's detach throws", async () => {
		const failing = probe("failing", { detach: true });
		const stage = createStage({ plugins: [failing.plugin] });
		await failing.context().http.add({
			protocol: "http",
			label: "rule",
			url: "/api/**",
			handle: () => ({ type: "fulfill" }),
		});
		const context = createFakeContext();
		await stage.attach(context);
		expect(context.routeCount).toBe(1);
		await expect(stage.detach(context)).rejects.toThrow(
			"failing cannot detach",
		);
		// The plugin's bug did not leak the route.
		expect(context.routeCount).toBe(0);
		expect(stage.attachments).toEqual([]);
	});

	it("disposes every plugin and stops its servers even when some steps throw", async () => {
		const calls: string[] = [];
		const a = probe("a", { dispose: true }, calls);
		const b = probe("b", { detach: true }, calls);
		const stage = createStage({ plugins: [a.plugin, b.plugin] });
		let held: (() => void) | undefined;
		await a.context().http.add({
			protocol: "http",
			label: "stream",
			url: "/api/**",
			handle: () => ({
				type: "stream",
				open(stream) {
					held = () => void stream.end();
				},
			}),
		});
		const context = createFakeContext();
		await stage.attach(context);
		// An open stream: the stream server is listening.
		const fetching = context
			.fetch()("http://app.test/api/s")
			.catch(() => {});
		await vi.waitFor(() => expect(held).toBeDefined());
		const failure = await stage.dispose().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AggregateError);
		expect(
			(failure as AggregateError).errors.map((e: Error) => e.message),
		).toEqual(["b cannot detach", "a cannot dispose"]);
		// Every step ran: both plugins, newest first, and the stream server.
		expect(calls.slice(-4)).toEqual([
			"b detach c1",
			"a detach c1",
			"b dispose",
			"a dispose",
		]);
		expect(context.routeCount).toBe(0);
		await fetching;
		// A second dispose has nothing left to do.
		await expect(stage.dispose()).resolves.toBeUndefined();
	});

	it("keeps a subscriber's failure away from whoever appended the frame", () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const stage = createStage({ plugins: [] });
		stage.timeline.subscribe(() => {
			throw new Error("assertion in a subscriber");
		});
		expect(() => append(stage, "/a")).not.toThrow();
		expect(stage.timeline.size).toBe(1);
		expect(logged).toHaveBeenCalled();
	});
});

describe("createStage: one plugin built on another", () => {
	it("sets the inner plugin up, runs its hooks, and does not mount it", async () => {
		const calls: string[] = [];
		const inner = probe("inner", {}, calls);
		let innerApi: { hello(): string } | undefined;
		const outer = definePlugin({
			name: "outer",
			setup(context) {
				innerApi = context.use(inner.plugin);
				return {
					api: { greet: () => `outer over ${innerApi?.hello()}` },
					attach: (a: Attachment) => {
						calls.push(`outer attach ${a.id}`);
					},
					dispose: () => {
						calls.push("outer dispose");
					},
				};
			},
		});
		const stage = createStage({ plugins: [outer] });
		expect(stage.outer.greet()).toBe("outer over hello from inner");
		expect("inner" in stage).toBe(false);
		await stage.attach(createFakeContext());
		await stage.dispose();
		// What a plugin builds on is attached before it and disposed after it.
		expect(calls).toEqual([
			"inner attach c1",
			"outer attach c1",
			"inner detach c1",
			"outer dispose",
			"inner dispose",
		]);
	});

	it("refuses a plugin asked for after setup", () => {
		const inner = probe("inner");
		let late: (() => unknown) | undefined;
		createStage({
			plugins: [
				definePlugin({
					name: "outer",
					setup(context) {
						late = () => context.use(inner.plugin);
						return { api: {} };
					},
				}),
			],
		});
		expect(late).toThrow(/asked for "inner" after setup/);
	});
});

describe("stage reads", () => {
	it("drains what is new since the last drain", async () => {
		const stage = createStage({ plugins: [] });
		append(stage, "/a");
		expect((await stage.drain()).map((f) => f.seq)).toEqual([1]);
		stage.timeline.append({
			protocol: "sse",
			kind: "event",
			direction: "in",
			endpoint: "/e",
			source: "stub",
		});
		append(stage, "/b");
		expect(
			(await stage.drain({ protocol: "rest" })).map((f) => f.endpoint),
		).toEqual(["/b"]);
		expect(await stage.drain()).toEqual([]);
		expect((await stage.frames()).length).toBe(3);
	});

	it("reads around markers", async () => {
		const stage = createStage({ plugins: [] });
		append(stage, "/before");
		const start = await stage.mark("start", { step: 1 });
		append(stage, "/inside");
		append(stage, "/also");
		await stage.mark("end");
		append(stage, "/after");
		expect(start).toMatchObject({
			protocol: "wirestage",
			source: "test",
			meta: { step: 1 },
		});
		expect(
			(await stage.since("start", { kind: "request" })).map((f) => f.endpoint),
		).toEqual(["/inside", "/also", "/after"]);
		// A later `after` than the marker wins, for `since` and `between` alike.
		expect(
			(await stage.since("start", { after: 3 })).map((f) => f.endpoint),
		).toEqual(["/also", "end", "/after"]);
		expect(
			(await stage.between("start", "end")).map((f) => f.endpoint),
		).toEqual(["/inside", "/also"]);
		expect(
			(await stage.between("start", "end", { after: 3 })).map(
				(f) => f.endpoint,
			),
		).toEqual(["/also"]);
		expect(
			(
				await stage.between("start", "end", {
					where: (f) => f.endpoint === "/also",
				})
			).map((f) => f.endpoint),
		).toEqual(["/also"]);
		await expect(stage.since("missing")).rejects.toThrow(/no marker "missing"/);
		await expect(stage.between("start", "missing")).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
		expect((await stage.frames(marker("start"))).length).toBe(1);
	});

	it("says when a missing marker may have been dropped at capacity", async () => {
		const stage = createStage({ plugins: [], capacity: 2 });
		await stage.mark("early");
		append(stage, "/a");
		append(stage, "/b");
		await expect(stage.since("early")).rejects.toThrow(
			/never placed, or it was among the 1 frame\(s\) dropped at capacity/,
		);
	});

	it("waits for frames, polling until they arrive", async () => {
		const clock = createManualClock();
		const stage = createStage({
			plugins: [],
			clock,
			wait: { interval: 10, timeout: 100 },
		});
		const waiting = stage.waitFor({ endpoint: "/late" }, { count: 2 });
		append(stage, "/late");
		await clock.advance(10);
		append(stage, "/late");
		await clock.advance(10);
		await expect(waiting).resolves.toHaveLength(2);
		// Already there: no waiting at all.
		await expect(stage.waitFor({ endpoint: "/late" })).resolves.toHaveLength(2);
	});

	it("times out listing what it looked for and what it saw", async () => {
		const clock = createManualClock();
		const stage = createStage({ plugins: [], clock });
		const waiting = stage.waitFor(
			{ endpoint: /never/, where: () => true },
			{ timeout: 30, interval: 20 },
		);
		const outcome = waiting.catch((error: unknown) => error);
		await clock.advance(20);
		await clock.advance(20);
		const error = (await outcome) as Error & { code: string };
		expect(error.code).toBe("TIMEOUT");
		expect(error.message).toContain(
			'{"endpoint":"/never/","where":"[function]"}',
		);
		expect(error.message).toContain("0 matched");
	});

	it("uses the stage defaults when waitFor gets no options", async () => {
		const clock = createManualClock();
		const stage = createStage({
			plugins: [],
			clock,
			wait: { timeout: 5, interval: 5 },
		});
		const outcome = stage
			.waitFor({ endpoint: "/x" })
			.catch((error: unknown) => error);
		await clock.advance(5);
		await expect(outcome).resolves.toMatchObject({ code: "TIMEOUT" });
		const plain = createStage({ plugins: [], clock });
		const defaults = plain
			.waitFor({ endpoint: "/x" })
			.catch((error: unknown) => error);
		await clock.advance(5_000);
		await expect(defaults).resolves.toMatchObject({ code: "TIMEOUT" });
	});

	it("waits, before a read, for a response that is already back", async () => {
		const { plugin, context } = probe();
		const stage = createStage({ plugins: [plugin] });
		await context().http.add({
			protocol: "http",
			label: "watch",
			url: "/api/**",
			handle: () => ({ type: "fallback" }),
		});
		const browser = createFakeContext();
		await stage.attach(browser);
		const { request } = await browser.dispatch("http://app.test/api/x");
		request.responseValue = fakeResponse(200, {}, "real");
		browser.emit("requestfinished", request);
		// No waiting or polling in the test: the read brings the timeline up
		// to date itself, and a marker placed now lands after the response.
		const frames = await stage.frames();
		expect(frames.map((f) => f.kind)).toEqual(["request", "response"]);
		const placed = await stage.mark("after");
		expect(placed.seq).toBe(3);
		await stage.dispose();
	});

	it("reports the newest frames as JSON and text, and exposes page ids", async () => {
		const stage = createStage({ plugins: [] });
		await stage.mark("only");
		const report = stage.report();
		expect(report.snapshot.frames).toHaveLength(1);
		expect(report.text).toContain("marker  only");
		const page = createFakeContext().newPage();
		expect(stage.pageId(page)).toBe("p1");
		expect(stage.pageId(page)).toBe("p1");

		for (let i = 0; i < 1_200; i++) append(stage, `/${i}`);
		// A report is read from its end, and must not grow with the test.
		const bounded = stage.report();
		expect(bounded.snapshot.frames).toHaveLength(1_000);
		expect(bounded.snapshot.omitted).toBe(201);
		expect(bounded.snapshot.frames.at(-1)?.endpoint).toBe("/1199");
		expect(bounded.text.split("\n")).toHaveLength(1_001);
		const short = stage.report({ protocol: "rest" }, { limit: 3 });
		expect(short.snapshot.frames.map((f) => f.endpoint)).toEqual([
			"/1197",
			"/1198",
			"/1199",
		]);
	});
});
