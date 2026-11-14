import { describe, expect, it, vi } from "vitest";

import { createManualClock } from "../shared/lib/clock/index.js";
import {
	compileFilter,
	createPayload,
	createTimeline,
	type Frame,
	type FrameInit,
} from "./frame/index.js";
import { definePlugin, named, type PluginRuntime } from "./plugin/index.js";

const frame = (over: Partial<FrameInit> = {}): FrameInit => ({
	protocol: "rest",
	kind: "request",
	direction: "out",
	endpoint: "/a",
	source: "page",
	...over,
});

describe("payload", () => {
	it("converts lazily and only once", () => {
		const encode = vi.fn(() => new TextEncoder().encode('{"a":1}'));
		const payload = createPayload(encode);
		expect(encode).not.toHaveBeenCalled();
		expect(payload.json()).toEqual({ a: 1 });
		expect(payload.text()).toBe('{"a":1}');
		payload.bytes();
		expect(encode).toHaveBeenCalledTimes(1);
		expect(payload.empty).toBe(false);
	});

	it("encodes given text and keeps given bytes", () => {
		expect(createPayload("hé").bytes()).toEqual(new TextEncoder().encode("hé"));
		const bytes = new Uint8Array([104, 105]);
		expect(createPayload(bytes).bytes()).toBe(bytes);
		expect(createPayload(bytes).text()).toBe("hi");
	});

	it("is empty without input", () => {
		const payload = createPayload(undefined);
		expect(payload.empty).toBe(true);
		expect(payload.bytes()).toEqual(new Uint8Array(0));
		expect(payload.text()).toBe("");
	});

	it("caches each decoder's result", () => {
		const payload = createPayload("abc");
		const decoder = vi.fn((b: Uint8Array) => b.length);
		expect(payload.decode(decoder)).toBe(3);
		expect(payload.decode(decoder)).toBe(3);
		expect(decoder).toHaveBeenCalledTimes(1);
		expect(payload.decode((b) => b[0])).toBe(97);
	});
});

describe("filter", () => {
	const sample = (over: Partial<Frame>): Frame =>
		({
			seq: 1,
			at: 0,
			protocol: "rest",
			kind: "request",
			direction: "out",
			endpoint: "/a",
			source: "page",
			payload: createPayload(undefined),
			value: undefined,
			meta: {},
			page: "p1",
			context: "c1",
			correlation: "x1",
			...over,
		}) as Frame;

	it("matches everything without a filter", () => {
		expect(compileFilter(undefined)(sample({}))).toBe(true);
		expect(compileFilter({})(sample({}))).toBe(true);
	});

	it("combines every field", () => {
		const match = compileFilter({
			protocol: ["rest", "sse"],
			kind: ["request"],
			direction: "out",
			source: "page",
			page: "p1",
			context: "c1",
			correlation: "x1",
			endpoint: /^\/a/g,
			after: 0,
			where: (f) => f.seq === 1,
		});
		expect(match(sample({}))).toBe(true);
		// The /g RegExp must not carry lastIndex over to the next frame.
		expect(match(sample({}))).toBe(true);
		expect(match(sample({ page: "p2" }))).toBe(false);
		expect(match(sample({ seq: 2 }))).toBe(false);
	});

	it("matches single values and exact endpoints", () => {
		const match = compileFilter({
			protocol: "rest",
			kind: "request",
			endpoint: "/a",
		});
		expect(match(sample({}))).toBe(true);
		expect(match(sample({ protocol: "sse" }))).toBe(false);
		expect(match(sample({ kind: "response" }))).toBe(false);
		expect(match(sample({ endpoint: "/b" }))).toBe(false);
		expect(compileFilter({ after: 1 })(sample({}))).toBe(false);
	});
});

describe("timeline", () => {
	it("appends in arrival order and stamps time from the clock", () => {
		const clock = createManualClock(1000);
		const timeline = createTimeline({ clock });
		const first = timeline.append(frame());
		const second = timeline.append(
			frame({ at: 5, kind: "response", direction: "in" }),
		);
		expect([first.seq, second.seq]).toEqual([1, 2]);
		expect(first.at).toBe(1000);
		expect(second.at).toBe(5);
		expect(first.meta).toEqual({});
		expect(timeline.size).toBe(2);
		expect(timeline.frames({ kind: "response" })).toEqual([second]);
		expect(timeline.last()).toBe(second);
		expect(timeline.last({ kind: "request" })).toBe(first);
	});

	it("finds the latest marker by name", () => {
		const timeline = createTimeline({ clock: createManualClock() });
		timeline.append(frame({ kind: "marker", endpoint: "go" }));
		const latest = timeline.append(frame({ kind: "marker", endpoint: "go" }));
		expect(timeline.marker("go")).toBe(latest);
		expect(timeline.marker("missing")).toBeUndefined();
	});

	it("notifies subscribers until they unsubscribe", () => {
		const timeline = createTimeline({ clock: createManualClock() });
		const seen: number[] = [];
		const stop = timeline.subscribe((f) => seen.push(f.seq));
		timeline.append(frame());
		stop();
		timeline.append(frame());
		expect(seen).toEqual([1]);
	});

	it("keeps the frame and the other subscribers when one throws", () => {
		const reported: unknown[] = [];
		const timeline = createTimeline({
			clock: createManualClock(),
			onListenerError: (error) => reported.push(error),
		});
		const seen: number[] = [];
		timeline.subscribe(() => {
			throw new Error("assertion in a subscriber");
		});
		timeline.subscribe((f) => seen.push(f.seq));
		// Whoever appends — a route handler, a page flush — is not broken by it.
		expect(timeline.append(frame()).seq).toBe(1);
		expect(seen).toEqual([1]);
		expect(reported).toHaveLength(1);
		expect(timeline.size).toBe(1);

		// On its own, a timeline has nobody to tell but the caller: it throws,
		// but only after the frame is in and every subscriber has run.
		const bare = createTimeline({ clock: createManualClock() });
		const later: number[] = [];
		bare.subscribe(() => {
			throw new Error("first");
		});
		bare.subscribe((f) => later.push(f.seq));
		expect(() => bare.append(frame())).toThrow("first");
		expect(later).toEqual([1]);
		expect(bare.size).toBe(1);
	});

	it("gives each cursor only what is new, narrowed by a filter", () => {
		const timeline = createTimeline({ clock: createManualClock() });
		timeline.append(frame());
		const cursor = timeline.cursor();
		expect(cursor.take()).toEqual([]);
		timeline.append(frame({ protocol: "sse" }));
		timeline.append(frame());
		expect(cursor.take({ protocol: "rest" }).map((f) => f.seq)).toEqual([3]);
		// The non-matching frame was consumed too: "since I last looked".
		expect(cursor.take()).toEqual([]);
		expect(cursor.position).toBe(3);
	});

	it("evicts the oldest tenth at capacity and keeps cursors valid", () => {
		const timeline = createTimeline({
			clock: createManualClock(),
			capacity: 10,
		});
		const cursor = timeline.cursor();
		for (let i = 0; i < 11; i++) timeline.append(frame());
		expect(timeline.size).toBe(10);
		expect(timeline.evicted).toBe(1);
		expect(timeline.capacity).toBe(10);
		expect(cursor.take().map((f) => f.seq)[0]).toBe(2);
		const tiny = createTimeline({ clock: createManualClock(), capacity: 1 });
		tiny.append(frame());
		tiny.append(frame());
		expect(tiny.frames().map((f) => f.seq)).toEqual([2]);
	});

	it("clears without calling it eviction, and keeps counting seq", () => {
		const timeline = createTimeline({ clock: createManualClock() });
		const cursor = timeline.cursor();
		timeline.append(frame());
		timeline.clear();
		expect(timeline.size).toBe(0);
		// `evicted` is what capacity cost; a report must not blame it for a clear.
		expect(timeline.evicted).toBe(0);
		expect(cursor.take()).toEqual([]);
		expect(timeline.append(frame()).seq).toBe(2);
		expect(cursor.take().map((f) => f.seq)).toEqual([2]);
	});

	it("rejects a capacity that is not a positive integer", () => {
		for (const capacity of [0, -1, 1.5])
			expect(() =>
				createTimeline({ clock: createManualClock(), capacity }),
			).toThrow(/positive integer/);
	});

	it("snapshots JSON-safely, cutting large payloads", () => {
		const timeline = createTimeline({ clock: createManualClock() });
		const cycle: Record<string, unknown> = {};
		cycle["self"] = cycle;
		timeline.append(
			frame({
				data: new Uint8Array(10),
				page: "p1",
				context: "c1",
				correlation: "x1",
				meta: { big: 10n, raw: new Uint8Array([1]), cycle, nothing: null },
			}),
		);
		timeline.append(frame({ data: "ok" }));
		const snapshot = timeline.snapshot(undefined, { maxBytes: 4 });
		const [first, second] = snapshot.frames;
		expect(first).toMatchObject({
			page: "p1",
			context: "c1",
			correlation: "x1",
			size: 10,
			truncated: true,
			meta: {
				big: "10",
				raw: "AQ==",
				cycle: { self: "[circular]" },
				nothing: null,
			},
		});
		expect(second).not.toHaveProperty("truncated");
		// One object in two places is shared, not circular.
		const shared = { id: 1 };
		timeline.append(frame({ meta: { a: shared, b: [shared, shared] } }));
		expect(timeline.snapshot().frames[2]?.meta).toEqual({
			a: { id: 1 },
			b: [{ id: 1 }, { id: 1 }],
		});
		expect(second).not.toHaveProperty("meta");
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
		expect(timeline.snapshot({ kind: "marker" }).frames).toEqual([]);
		// Default byte limit.
		expect(timeline.snapshot().frames[0]?.truncated).toBeUndefined();
	});

	it("keeps the newest frames of a snapshot, and says how many it left out", () => {
		const timeline = createTimeline({ clock: createManualClock() });
		for (let i = 0; i < 5; i++) timeline.append(frame());
		const limited = timeline.snapshot(undefined, { limit: 2 });
		expect(limited.frames.map((f) => f.seq)).toEqual([4, 5]);
		expect(limited.omitted).toBe(3);
		const whole = timeline.snapshot(undefined, { limit: 5 });
		expect(whole.frames).toHaveLength(5);
		expect(whole.omitted).toBe(0);
		expect(timeline.snapshot().omitted).toBe(0);
	});

	it("formats a readable listing relative to the first frame shown", () => {
		const clock = createManualClock(100);
		const timeline = createTimeline({ clock });
		timeline.append(frame({ page: "p1" }));
		timeline.append(frame({ at: 103.5, data: "four", kind: "message" }));
		expect(timeline.format()).toBe(
			"#1  +0.0ms  rest  out request  /a  p1\n#2  +3.5ms  rest  out message  /a  4B",
		);
		expect(timeline.format(undefined, { limit: 1 })).toBe(
			"… 1 earlier frames not shown\n#2  +0.0ms  rest  out message  /a  4B",
		);
		expect(createTimeline({ clock }).format()).toBe("");
		// No frames, not all of them.
		expect(timeline.format(undefined, { limit: 0 })).toBe(
			"… 2 earlier frames not shown",
		);
	});
});

describe("named", () => {
	it("renames a plugin written as a class, keeping its methods and state", () => {
		class Counter {
			readonly name = "counter";
			readonly scope = "Count";
			#count = 41;
			setup(): PluginRuntime<{ next(): number }> {
				return { api: { next: () => ++this.#count } };
			}
		}
		const renamed = named("tally", new Counter());
		expect(renamed).toMatchObject({ name: "tally", scope: "Count" });
		// A spread copies own properties only: `setup` lives on the prototype.
		const { api } = renamed.setup(
			{} as Parameters<(typeof renamed)["setup"]>[0],
		);
		expect(api.next()).toBe(42);
	});
});

describe("definePlugin", () => {
	it("returns the plugin unchanged", () => {
		const plugin = { name: "x", setup: () => ({ api: 1 }) } as const;
		expect(definePlugin(plugin)).toBe(plugin);
	});
});
