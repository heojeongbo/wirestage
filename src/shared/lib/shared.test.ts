import { describe, expect, it, vi } from "vitest";

import {
	createArrivals,
	createAsyncQueue,
	createDeferred,
	runAll,
} from "./async/index.js";
import {
	concatBytes,
	fromBase64,
	toBase64,
	toBuffer,
	toBytes,
	utf8,
} from "./bytes/index.js";
import { createManualClock, createSystemClock } from "./clock/index.js";
import { parseSetCookie } from "./cookies/index.js";
import {
	createEnvelopeReader,
	decodeEnvelopes,
	EnvelopeFlag,
	encodeEnvelope,
	encodeEnvelopes,
	parseTrailerBlock,
} from "./envelope/index.js";
import { isWirestageError, WirestageError } from "./errors/index.js";
import { createObjectIds, createSequence, randomToken } from "./id/index.js";
import { compileUrlMatcher, globToRegExp } from "./match/index.js";

describe("errors", () => {
	it("carries a code, details and a cause", () => {
		const cause = new Error("root");
		const error = new WirestageError("TIMEOUT", "slow", {
			cause,
			details: { ms: 5 },
		});
		expect(error.name).toBe("WirestageError");
		expect(error.code).toBe("TIMEOUT");
		expect(error.details).toEqual({ ms: 5 });
		expect(error.cause).toBe(cause);
		// Without options there is no cause property at all, rather than an
		// explicit `undefined` that serializers print.
		expect("cause" in new WirestageError("CLOSED", "x")).toBe(false);
		expect(new WirestageError("CLOSED", "x").details).toEqual({});
	});

	it("narrows by code", () => {
		const error = new WirestageError("CLOSED", "x");
		expect(isWirestageError(error)).toBe(true);
		expect(isWirestageError(error, "CLOSED")).toBe(true);
		expect(isWirestageError(error, "TIMEOUT")).toBe(false);
		expect(isWirestageError(new Error("x"))).toBe(false);
	});
});

describe("bytes", () => {
	it("views binary without copying and encodes text", () => {
		const view = new Uint8Array([1, 2, 3]);
		expect(toBytes(view)).toBe(view);
		expect(toBytes(view.buffer)).toEqual(view);
		const dataView = new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2);
		expect(toBytes(dataView)).toEqual(new Uint8Array([8, 7]));
		expect(utf8(toBytes("héllo"))).toBe("héllo");
	});

	it("concatenates, short-circuiting a single chunk", () => {
		const one = new Uint8Array([1]);
		expect(concatBytes([one])).toBe(one);
		expect(concatBytes([one, new Uint8Array([2, 3])])).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		expect(concatBytes([])).toEqual(new Uint8Array(0));
	});

	it("round-trips base64 and shares memory with Buffer", () => {
		const bytes = new Uint8Array([0, 255, 128]);
		expect(fromBase64(toBase64(bytes))).toEqual(bytes);
		const backing = new Uint8Array([5, 6, 7]);
		const buffer = toBuffer(backing.subarray(1));
		buffer[0] = 9;
		// Same memory: a recorded payload is never copied twice.
		expect(backing[1]).toBe(9);
	});
});

describe("envelope", () => {
	it("encodes and decodes the 5-byte header", () => {
		const data = new Uint8Array([1, 2, 3]);
		const encoded = encodeEnvelope(EnvelopeFlag.trailer, data);
		expect([...encoded.subarray(0, 5)]).toEqual([0x80, 0, 0, 0, 3]);
		const { envelopes, rest } = decodeEnvelopes(
			encodeEnvelopes([
				{ flags: 0, data },
				{ flags: EnvelopeFlag.endStream, data: new Uint8Array(0) },
			]),
		);
		expect(rest).toBe(0);
		expect(envelopes.map((e) => e.flags)).toEqual([0, 2]);
		expect(envelopes[0]?.data).toEqual(data);
	});

	it("reassembles an envelope split anywhere, header included", () => {
		const whole = encodeEnvelopes([
			{ flags: 0, data: new Uint8Array([7, 7]) },
			{ flags: 1, data: new Uint8Array([8]) },
		]);
		const reader = createEnvelopeReader();
		const seen = [];
		for (const byte of whole) seen.push(...reader.push(new Uint8Array([byte])));
		expect(seen.map((e) => [...e.data])).toEqual([[7, 7], [8]]);
		expect(reader.buffered).toBe(0);
		// A truncated tail is held back and reported, not dropped silently.
		expect(decodeEnvelopes(whole.subarray(0, whole.length - 1)).rest).toBe(5);
	});

	it("joins a large envelope once, however many chunks deliver it", () => {
		const payload = new Uint8Array(64 * 1024).fill(9);
		const whole = encodeEnvelope(0, payload);
		const reader = createEnvelopeReader();
		const seen = [];
		const chunks: Uint8Array[] = [];
		for (let at = 0; at < whole.length; at += 1024)
			chunks.push(whole.subarray(at, at + 1024));
		for (const chunk of chunks) {
			const before = reader.buffered;
			const out = reader.push(chunk);
			seen.push(...out);
			// Until the envelope completes, chunks are only held, not rejoined.
			if (out.length === 0)
				expect(reader.buffered).toBe(before + chunk.byteLength);
		}
		expect(seen).toHaveLength(1);
		expect(seen[0]?.data).toEqual(payload);
		expect(reader.buffered).toBe(0);
		// What follows a completed envelope in the same chunk is kept for the next.
		const two = createEnvelopeReader();
		const pair = encodeEnvelopes([
			{ flags: 0, data: new Uint8Array([1]) },
			{ flags: 0, data: new Uint8Array([2, 2]) },
		]);
		expect(two.push(pair.subarray(0, 8))).toHaveLength(1);
		expect(two.buffered).toBe(2);
		expect(two.push(pair.subarray(8)).map((e) => [...e.data])).toEqual([
			[2, 2],
		]);
	});

	it("parses a trailer block, lower-casing names and skipping junk", () => {
		const block = new TextEncoder().encode(
			"Grpc-Status: 5\r\ngrpc-message: not%20found\r\n\r\nnocolon\n:empty\n",
		);
		expect(parseTrailerBlock(block)).toEqual({
			"grpc-status": "5",
			"grpc-message": "not%20found",
		});
	});
});

describe("url matcher", () => {
	const url = (href: string) => new URL(href);

	it("treats a leading slash as a path pattern on any origin", () => {
		const match = compileUrlMatcher("/api/**");
		expect(match(url("http://a.test/api/x/y"))).toBe(true);
		expect(match(url("https://b.test/api/z"))).toBe(true);
		expect(match(url("http://a.test/other"))).toBe(false);
	});

	it("follows Playwright's glob semantics on full URLs", () => {
		expect(compileUrlMatcher("**/v1/*")(url("http://h/v1/x"))).toBe(true);
		// `*` stops at a slash.
		expect(compileUrlMatcher("**/v1/*")(url("http://h/v1/x/y"))).toBe(false);
		expect(compileUrlMatcher("http://h/{a,b}")(url("http://h/b"))).toBe(true);
		expect(compileUrlMatcher("http://h/{a,b}")(url("http://h/c"))).toBe(false);
		// `?` and an escaped `*` are literal; a stray `}` or `,` outside a group too.
		expect(globToRegExp("/a?b").test("/a?b")).toBe(true);
		expect(globToRegExp("/a?b").test("/axb")).toBe(false);
		expect(globToRegExp("/a\\*").test("/a*")).toBe(true);
		expect(globToRegExp("/a}b,c").test("/a}b,c")).toBe(true);
		expect(globToRegExp("/tail\\").test("/tail\\")).toBe(true);
	});

	it("lets a `**` directory be absent, as Playwright does", () => {
		const nested = compileUrlMatcher("/api/**/users");
		expect(nested(url("http://h/api/users"))).toBe(true);
		expect(nested(url("http://h/api/v1/eu/users"))).toBe(true);
		expect(nested(url("http://h/api/users/7"))).toBe(false);
		const anywhere = compileUrlMatcher("**/api/users");
		expect(anywhere(url("http://h/api/users"))).toBe(true);
		expect(anywhere(url("http://h/x/api/users"))).toBe(true);
		// A trailing `**` still takes everything, slashes included.
		expect(compileUrlMatcher("/api/**")(url("http://h/api/a/b"))).toBe(true);
	});

	it("refuses a pattern that could never match, saying why", () => {
		// A path has no query, so this would compile and then match nothing.
		expect(() => compileUrlMatcher("/search?q=1")).toThrow(
			/matches the path, which has no query/,
		);
		// The whole-URL form of the same pattern is fine.
		expect(compileUrlMatcher("**/search?q=1")(url("http://h/search?q=1"))).toBe(
			true,
		);
		expect(() => compileUrlMatcher("/api/{a,b")).toThrow(
			expect.objectContaining({ code: "INVALID_ARGUMENT" }),
		);
		// An escaped brace is a literal, not a group.
		expect(compileUrlMatcher("/api/\\{x")(url("http://h/api/%7Bx"))).toBe(
			false,
		);
		expect(globToRegExp("/api/\\{x").test("/api/{x")).toBe(true);
	});

	it("resets a stateful RegExp between requests", () => {
		const match = compileUrlMatcher(/api/g);
		expect(match(url("http://h/api"))).toBe(true);
		expect(match(url("http://h/api"))).toBe(true);
	});

	it("passes a predicate through", () => {
		const predicate = (u: URL) => u.port === "8080";
		expect(compileUrlMatcher(predicate)).toBe(predicate);
	});
});

describe("clock", () => {
	it("tells epoch time and sleeps", async () => {
		const clock = createSystemClock();
		expect(Math.abs(clock.now() - Date.now())).toBeLessThan(1_000);
		await clock.sleep(1);
	});

	it("rejects with the abort reason, before or during the sleep", async () => {
		const clock = createSystemClock();
		await expect(clock.sleep(5, AbortSignal.abort("early"))).rejects.toBe(
			"early",
		);
		const controller = new AbortController();
		const sleeping = clock.sleep(10_000, controller.signal);
		controller.abort("late");
		await expect(sleeping).rejects.toBe("late");
	});

	it("sleeps for good when asked to, instead of overflowing to an instant", async () => {
		const clock = createSystemClock();
		const controller = new AbortController();
		let woke = false;
		const forever = clock.sleep(Number.POSITIVE_INFINITY, controller.signal);
		forever.then(
			() => {
				woke = true;
			},
			() => {},
		);
		await clock.sleep(20);
		expect(woke).toBe(false);
		controller.abort("enough");
		await expect(forever).rejects.toBe("enough");
	});

	it("moves a manual clock in due order", async () => {
		const clock = createManualClock(100);
		const order: number[] = [];
		void clock.sleep(20).then(() => order.push(clock.now()));
		void clock.sleep(10).then(() => order.push(clock.now()));
		expect(clock.pending).toBe(2);
		await clock.advance(15);
		expect(order).toEqual([110]);
		await clock.advance(10);
		expect(order).toEqual([110, 120]);
		expect(clock.now()).toBe(125);
		expect(clock.pending).toBe(0);
	});

	it("resolves sleeps that fall due together in due order", async () => {
		const clock = createManualClock();
		const order: string[] = [];
		void clock.sleep(5).then(() => order.push("five"));
		void clock.sleep(3).then(() => order.push("three"));
		await clock.advance(10);
		expect(order).toEqual(["three", "five"]);
	});

	it("cancels a manual sleep on abort", async () => {
		const clock = createManualClock();
		await expect(clock.sleep(1, AbortSignal.abort("no"))).rejects.toBe("no");
		const controller = new AbortController();
		const sleeping = clock.sleep(10, controller.signal);
		controller.abort("stop");
		await expect(sleeping).rejects.toBe("stop");
		expect(clock.pending).toBe(0);
	});
});

describe("async", () => {
	it("settles a deferred once", async () => {
		const deferred = createDeferred<number>();
		expect(deferred.settled).toBe(false);
		deferred.resolve(1);
		deferred.resolve(2);
		deferred.reject(new Error("late"));
		expect(deferred.settled).toBe(true);
		await expect(deferred.promise).resolves.toBe(1);
		const rejected = createDeferred<number>();
		rejected.reject(new Error("x"));
		rejected.resolve(3);
		await expect(rejected.promise).rejects.toThrow("x");
	});

	it("queues values pushed before and after the consumer starts", async () => {
		const queue = createAsyncQueue<number>();
		void queue.push(1);
		expect(queue.size).toBe(1);
		const seen: number[] = [];
		const consuming = (async () => {
			for await (const value of queue) seen.push(value);
		})();
		// Let the consumer drain the first value and park, waiting for more.
		await new Promise((resolve) => setTimeout(resolve, 0));
		void queue.push(2);
		queue.close();
		expect(queue.closed).toBe(true);
		await consuming;
		expect(seen).toEqual([1, 2]);
		await expect(queue.push(3)).rejects.toMatchObject({ code: "CLOSED" });
	});

	it("resolves a push once the consumer is through the value", async () => {
		const queue = createAsyncQueue<string>();
		const iterator = queue[Symbol.asyncIterator]();
		let through = false;
		const pushed = queue.push("a").then(() => {
			through = true;
		});
		expect((await iterator.next()).value).toBe("a");
		// Taken, but the consumer is still working on it.
		await Promise.resolve();
		expect(through).toBe(false);
		const next = iterator.next();
		await pushed;
		expect(through).toBe(true);
		queue.close();
		expect((await next).done).toBe(true);
	});

	it("rejects what a consumer that left never got through", async () => {
		const queue = createAsyncQueue<string>();
		const iterator = queue[Symbol.asyncIterator]();
		const held = queue.push("held");
		const unreached = queue.push("never reached");
		await iterator.next();
		// The consumer stops while holding the first value.
		await iterator.return?.(undefined);
		await expect(held).rejects.toMatchObject({ code: "CLOSED" });
		await expect(unreached).rejects.toMatchObject({ code: "CLOSED" });
		expect(queue.size).toBe(0);
		// And the queue is over for whoever pushes next.
		await expect(queue.push("late")).rejects.toMatchObject({ code: "CLOSED" });
	});

	it("runs every teardown step, then throws what failed", async () => {
		const ran: string[] = [];
		const step = (name: string, fail?: unknown) => async () => {
			ran.push(name);
			if (fail !== undefined) throw fail;
		};
		await expect(runAll([step("a"), step("b")])).resolves.toBeUndefined();
		const one = new Error("one");
		await expect(runAll([step("c", one), step("d")])).rejects.toBe(one);
		const several = await runAll([
			step("e", new Error("first")),
			() => {
				ran.push("sync");
				throw new Error("second");
			},
			step("f"),
		]).catch((error: unknown) => error);
		expect(several).toBeInstanceOf(AggregateError);
		expect((several as AggregateError).errors).toHaveLength(2);
		expect(ran).toEqual(["a", "b", "c", "d", "e", "sync", "f"]);
	});

	it("fails iteration after the queued values, and ignores a second end", async () => {
		const queue = createAsyncQueue<number>();
		void queue.push(1);
		queue.fail(new Error("boom"));
		queue.fail(new Error("ignored"));
		const seen: number[] = [];
		await expect(
			(async () => {
				for await (const value of queue) seen.push(value);
			})(),
		).rejects.toThrow("boom");
		expect(seen).toEqual([1]);
		const closedFirst = createAsyncQueue<number>();
		closedFirst.close();
		closedFirst.fail(new Error("too late"));
		const empty: number[] = [];
		for await (const value of closedFirst) empty.push(value);
		expect(empty).toEqual([]);
	});

	it("adds what the waiter knows to a timeout", async () => {
		const clock = createManualClock();
		let lost = 0;
		const arrivals = createArrivals<string>({
			clock,
			label: "stream",
			timeout: 10,
			hint: () => (lost > 0 ? `${lost} never reached the server` : undefined),
		});
		const plain = arrivals.next().catch((error: Error) => error.message);
		await clock.advance(10);
		expect(await plain).toBe("no stream arrived within 10 ms (0 seen so far)");
		lost = 2;
		const hinted = arrivals.next().catch((error: Error) => error.message);
		await clock.advance(10);
		expect(await hinted).toBe(
			"no stream arrived within 10 ms (0 seen so far); 2 never reached the server",
		);
	});

	it("returns arrivals in order, waiting when none is pending", async () => {
		const clock = createManualClock();
		const arrivals = createArrivals<string>({
			clock,
			label: "call",
			timeout: 50,
		});
		arrivals.push("a");
		expect(await arrivals.next()).toBe("a");
		const waiting = arrivals.next();
		arrivals.push("b");
		expect(await waiting).toBe("b");
		expect(arrivals.items).toEqual(["a", "b"]);
		expect(arrivals.latest).toBe("b");
	});

	it("times out with what it saw, and hands one push to one of two waiters", async () => {
		const clock = createManualClock();
		const arrivals = createArrivals<string>({
			clock,
			label: "call",
			timeout: 50,
		});
		const first = arrivals.next();
		const second = arrivals.next({ timeout: 100 });
		arrivals.push("only");
		await clock.advance(60);
		await expect(first).resolves.toBe("only");
		await clock.advance(60);
		await expect(second).rejects.toMatchObject({
			code: "TIMEOUT",
			details: { label: "call", seen: 1 },
		});
		await expect(
			createArrivals({ clock, label: "x" }).next({ timeout: 0 }),
		).rejects.toThrow(/no x arrived within 0 ms/);
	});

	it("takes an item that lands in the same turn the deadline passes", async () => {
		// The timeout wins the race, then the item arrives before the waiter
		// gives up: it must be returned, not reported as a timeout.
		const clock = createManualClock();
		const arrivals = createArrivals<string>({ clock, label: "late" });
		vi.spyOn(clock, "sleep").mockImplementation(async (_ms, signal) => {
			signal?.addEventListener("abort", () => arrivals.push("just in time"));
		});
		await expect(arrivals.next({ timeout: 10 })).resolves.toBe("just in time");
	});
});

describe("ids", () => {
	it("counts per prefix", () => {
		const next = createSequence("p");
		expect([next(), next()]).toEqual(["p1", "p2"]);
	});

	it("keeps one id per object", () => {
		const idOf = createObjectIds<object>("c");
		const a = {};
		expect(idOf(a)).toBe("c1");
		expect(idOf({})).toBe("c2");
		expect(idOf(a)).toBe("c1");
	});

	it("makes unguessable tokens", () => {
		expect(randomToken()).toMatch(/^[0-9a-f]{32}$/);
		expect(randomToken()).not.toBe(randomToken());
	});
});

describe("set-cookie", () => {
	const NOW = Date.UTC(2026, 0, 1);

	it("stores a bare cookie host-only, under the request path's directory", () => {
		expect(
			parseSetCookie("sid=abc", "http://app.test/api/svc/Method", NOW),
		).toEqual({
			name: "sid",
			value: "abc",
			domain: "app.test",
			path: "/api/svc",
			httpOnly: false,
			secure: false,
		});
		expect(parseSetCookie("a=1", "http://app.test/", NOW)?.path).toBe("/");
		expect(parseSetCookie("a=1", "http://app.test/x", NOW)?.path).toBe("/");
	});

	it("reads every attribute, in any case, values trimmed", () => {
		expect(
			parseSetCookie(
				" sid = a=b ; Domain=.App.Test; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly; secure; SameSite=lax",
				"https://x.app.test/api/a",
				NOW,
			),
		).toEqual({
			name: "sid",
			value: "a=b",
			domain: ".app.test",
			path: "/",
			expires: Date.UTC(2026, 9, 21, 7, 28) / 1000,
			httpOnly: true,
			secure: true,
			sameSite: "Lax",
		});
		for (const [given, kept] of [
			["Strict", "Strict"],
			["NONE", "None"],
		] as const)
			expect(
				parseSetCookie(`a=1; SameSite=${given}`, "http://h/", NOW)?.sameSite,
			).toBe(kept);
	});

	it("lets Max-Age win over Expires, an expired one included", () => {
		expect(
			parseSetCookie(
				"a=1; Max-Age=60; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
				"http://h/",
				NOW,
			)?.expires,
		).toBe(NOW / 1000 + 60);
		expect(parseSetCookie("a=1; Max-Age=0", "http://h/", NOW)?.expires).toBe(
			NOW / 1000,
		);
	});

	it("keeps the expiry inside what a browser context accepts", () => {
		// A context refuses a negative timestamp; "long expired" deletes too.
		expect(
			parseSetCookie("a=1; Max-Age=-99999999999", "http://h/", NOW)?.expires,
		).toBe(1);
		expect(
			parseSetCookie("a=1; Max-Age=99999999999999", "http://h/", NOW)?.expires,
		).toBe(253_402_300_799);
		// A bare number is not a date, whatever `Date.parse` makes of it.
		expect(
			parseSetCookie("a=1; Expires=1", "http://h/", NOW)?.expires,
		).toBeUndefined();
	});

	it("drops a cookie for a site the responding host is not part of", () => {
		expect(
			parseSetCookie("sid=1; Domain=bank.example", "https://app.test/", NOW),
		).toBeUndefined();
		expect(
			parseSetCookie("sid=1; Domain=evilapp.test", "https://app.test/", NOW),
		).toBeUndefined();
		// Its own host, or a parent of it, is fine.
		expect(
			parseSetCookie("sid=1; Domain=app.test", "https://app.test/", NOW)
				?.domain,
		).toBe(".app.test");
		expect(
			parseSetCookie("sid=1; Domain=test", "https://api.app.test/", NOW)
				?.domain,
		).toBe(".test");
	});

	it("ignores attributes it cannot use, and lines with no name", () => {
		expect(
			parseSetCookie(
				"a=1; Domain=; Path=relative; Expires=soon; Max-Age=1.5; SameSite=sometimes; Priority=High",
				"http://h/p/q",
				NOW,
			),
		).toEqual({
			name: "a",
			value: "1",
			domain: "h",
			path: "/p",
			httpOnly: false,
			secure: false,
		});
		expect(parseSetCookie("=orphan", "http://h/", NOW)).toBeUndefined();
		expect(parseSetCookie("novalue", "http://h/", NOW)).toBeUndefined();
	});

	it("reads the real clock by default", () => {
		const before = Math.floor(Date.now() / 1000);
		const expires = parseSetCookie("a=1; Max-Age=10", "http://h/")?.expires;
		expect(expires).toBeGreaterThanOrEqual(before + 10);
	});
});
