/**
 * The HTTP router and its live streams against a real Chromium, through the
 * real Playwright API. The first block shows what the fakes of
 * src/__fixtures__ claim Playwright and Chromium do; the rest, that the
 * router answers, records and lets go the way the unit suite says it does.
 */
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";

import {
	type Browser,
	type BrowserContext,
	type BrowserContextOptions,
	chromium,
	type Page,
	type Route,
} from "@playwright/test";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createTimeline } from "../../src/entities/frame/index.js";
import {
	type AnyWirePlugin,
	createStage,
	createSystemClock,
	definePlugin,
	type HttpRule,
	type ResponseStream,
} from "../../src/index.js";
import { rest } from "../../src/rest.js";
import { createStreamServer } from "../../src/shared/api/stream-server/index.js";
import { createSequence } from "../../src/shared/lib/id/index.js";
import { createScopedLogger } from "../../src/shared/lib/logger/index.js";
import { sse } from "../../src/sse.js";
import { createHttpRouter } from "../../src/widgets/stage/lib/http-router.js";

/** A loopback origin that a route serves: Chromium places it nowhere. */
const ORIGIN = "http://localhost:4510";
const HTML = "<!doctype html><title>t</title>";

let browser: Browser | undefined;
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});
afterAll(async () => {
	await browser?.close();
	browser = undefined;
});

async function newContext(options?: BrowserContextOptions) {
	browser ??= await chromium.launch();
	const context = await browser.newContext(options);
	disposers.push(() => context.close());
	return context;
}

/** A context whose `origin` a route serves: `html` at `/`, a 404 elsewhere. */
async function contextWithPage(
	origin = ORIGIN,
	options?: BrowserContextOptions,
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await newContext(options);
	await context.route(`${origin}/**`, (route) =>
		new URL(route.request().url()).pathname === "/"
			? route.fulfill({ status: 200, contentType: "text/html", body: HTML })
			: route.fulfill({ status: 404, body: "not stubbed" }),
	);
	return { context, page: await context.newPage() };
}

/** A real server on loopback: what an app's dev server is. */
async function loopbackServer(listener: RequestListener) {
	const server = createServer(listener);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	disposers.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A plugin that takes the test's own HTTP rules. */
const probe = definePlugin({
	name: "probe",
	setup: (context) => ({
		api: {
			add: (rule: Omit<HttpRule, "protocol">) =>
				context.http.add({ protocol: context.name, ...rule }),
		},
	}),
});

async function stageOn<const Plugins extends readonly AnyWirePlugin[]>(
	plugins: Plugins,
) {
	const { context, page } = await contextWithPage();
	const stage = createStage({ plugins, pageFlushMs: 5 });
	await stage.attach(context);
	disposers.push(() => stage.dispose());
	await page.goto(`${ORIGIN}/`);
	return { stage, context, page };
}

/** What a fetch from the page came to, or "hung" when nothing came in `ms`. */
const fetchIn = (page: Page, url: string, ms = 1_000) =>
	page.evaluate(
		({ url, ms }) =>
			Promise.race([
				fetch(url, { method: "POST", body: "q" }).then(
					async (response) => {
						try {
							return `${response.status} ${await response.text()}`;
						} catch (error) {
							return `${response.status}, then ${String(error)}`;
						}
					},
					(error) => `rejected: ${String(error)}`,
				),
				new Promise<string>((resolve) => setTimeout(() => resolve("hung"), ms)),
			]),
		{ url, ms },
	);

describe("Playwright and Chromium, as the fakes have them", () => {
	it("hand a route one answer: one refused after it was taken leaves the page waiting", async () => {
		const { context, page } = await contextWithPage();
		const refusals: string[] = [];
		const firsts: Record<string, (route: Route) => Promise<void>> = {
			"/relative": (route) => route.continue({ url: "/elsewhere" }),
			"/scheme": (route) =>
				route.continue({ url: "https://localhost:4510/elsewhere" }),
			"/code": (route) => route.abort("bogus"),
		};
		await context.route(`${ORIGIN}/api/**`, async (route) => {
			const first = firsts[new URL(route.request().url()).pathname.slice(4)];
			await (first as (route: Route) => Promise<void>)(route).catch(
				async (error: unknown) => {
					refusals.push(String(error).split("\n")[0] as string);
					await route
						.fulfill({ status: 500 })
						.catch((second: unknown) =>
							refusals.push(String(second).split("\n")[0] as string),
						);
				},
			);
		});
		await page.goto(`${ORIGIN}/`);
		const seen = await Promise.all(
			Object.keys(firsts).map((path) => fetchIn(page, `/api${path}`)),
		);
		expect(seen).toEqual(["hung", "hung", "hung"]);
		expect(refusals.sort()).toEqual([
			"Error: route.abort: Unknown error code: bogus",
			"Error: route.continue: New URL must have same protocol as overridden URL",
			"Error: route.fulfill: Route is already handled!",
			"Error: route.fulfill: Route is already handled!",
			"Error: route.fulfill: Route is already handled!",
			"TypeError: route.continue: Invalid URL",
		]);
	});

	it("drop an answer with a header they refuse, which reads as sent, and give set-cookie a line per value", async () => {
		const real = await loopbackServer((_request, response) =>
			response.end("reached"),
		);
		const { context, page } = await contextWithPage();
		await context.grantPermissions(["local-network-access"], {
			origin: ORIGIN,
		});
		const sent: string[] = [];
		const finished: string[] = [];
		context.on("requestfinished", (request) => finished.push(request.url()));
		await context.route(`${ORIGIN}/api/**`, async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/api/fulfill")
				await route.fulfill({ headers: { "x-multi": "a\nb" }, body: "x" });
			else if (path === "/api/continue")
				await route.continue({
					url: `${real}/`,
					headers: { ...route.request().headers(), "x-multi": "a\nb" },
				});
			else
				await route.fulfill({
					headers: { "set-cookie": "a=1; Path=/\nb=2; Path=/" },
					body: "cookies",
				});
			sent.push(path);
		});
		await page.goto(`${ORIGIN}/`);
		expect(await fetchIn(page, "/api/fulfill")).toBe("hung");
		expect(await fetchIn(page, "/api/continue")).toBe("hung");
		expect(await fetchIn(page, "/api/cookies")).toBe("200 cookies");
		expect(await page.evaluate(() => document.cookie)).toBe("a=1; b=2");
		// Both refused answers resolved; neither request ever finished.
		expect(sent.sort()).toEqual([
			"/api/continue",
			"/api/cookies",
			"/api/fulfill",
		]);
		expect(finished.filter((url) => url.includes("/api/"))).toEqual([
			`${ORIGIN}/api/cookies`,
		]);
	});

	it("name no server for a document a route made up, and one Frame for a frame's requests", async () => {
		const real = await loopbackServer((_request, response) =>
			response.writeHead(200, { "content-type": "text/html" }).end(HTML),
		);
		const { context, page } = await contextWithPage();
		const seen: string[] = [];
		context.on("requestfinished", async (request) => {
			if (!["document", "fetch"].includes(request.resourceType())) return;
			const response = await request.response();
			seen.push(
				`${request.resourceType()} ${JSON.stringify(await response?.serverAddr())} ${request.frame() === page.mainFrame()}`,
			);
		});
		await page.goto(`${ORIGIN}/`);
		await page.goto(`${real}/`);
		await page.evaluate(() =>
			fetch("/data").then((response) => response.text()),
		);
		await expect.poll(() => seen.length).toBe(3);
		const port = Number(new URL(real).port);
		expect(seen.sort()).toEqual([
			"document null true",
			`document {"ipAddress":"127.0.0.1","port":${port}} true`,
			`fetch {"ipAddress":"127.0.0.1","port":${port}} true`,
		]);
	});

	it("fail a body the server cut short, even after `connection: close`", async () => {
		const real = await loopbackServer((_request, response) => {
			response.writeHead(200, {
				"access-control-allow-origin": "*",
				connection: "close",
			});
			response.write("part", () => response.destroy());
		});
		const { context, page } = await contextWithPage();
		await context.grantPermissions(["local-network-access"], {
			origin: ORIGIN,
		});
		await page.goto(`${ORIGIN}/`);
		expect(await fetchIn(page, `${real}/`)).toBe(
			"200, then TypeError: Failed to fetch",
		);
	});
});

describe("http router in Chromium", () => {
	it("answers a stream rule that throws as its error: a 500 naming it, or a cut once it began", async () => {
		const { stage, page } = await stageOn([probe]);
		await stage.probe.add({
			label: "ndjson /api/early",
			url: "/api/early",
			handle: () => ({
				type: "stream",
				async open(stream) {
					stream.head(200, { "content-type": "application/x-ndjson" });
					// The example of docs/plugins.md, given a bigint.
					await stream.write(`${JSON.stringify({ id: 1n })}\n`);
				},
			}),
		});
		await stage.probe.add({
			label: "ndjson /api/late",
			url: "/api/late",
			handle: () => ({
				type: "stream",
				async open(stream) {
					stream.head(200, { "content-type": "application/x-ndjson" });
					await stream.write('{"id":1}\n');
					throw new Error("bug mid-stream");
				},
			}),
		});
		expect(await fetchIn(page, "/api/early")).toBe(
			'500 wirestage: rule "ndjson /api/early" failed: Do not know how to serialize a BigInt',
		);
		// Not a clean 200: what came before the error is not the whole answer.
		expect(await fetchIn(page, "/api/late")).toBe(
			"200, then TypeError: Failed to fetch",
		);
		const frames = await stage.frames({ protocol: "probe" });
		expect(
			frames
				.filter((frame) => frame.kind !== "request")
				.map((frame) => [frame.kind, frame.source, frame.meta["reason"]]),
		).toEqual([
			["fault", "stub", "rule-error"],
			["fault", "stub", "rule-error"],
		]);
	});

	it("fails a stream cut before its first byte the same way after a clean stream as on a fresh connection", async () => {
		const { stage, page } = await stageOn([probe]);
		const opened: ResponseStream[] = [];
		await stage.probe.add({
			label: "stream",
			url: "/api/stream",
			handle: () => ({
				type: "stream",
				open(stream) {
					opened.push(stream);
				},
			}),
		});
		const answer = (cut: boolean) => {
			const seen = fetchIn(page, "/api/stream", 5_000);
			const count = opened.length + 1;
			return expect
				.poll(() => opened.length)
				.toBe(count)
				.then(async () => {
					const stream = opened[count - 1] as ResponseStream;
					if (cut) stream.cut();
					else {
						await stream.write("one");
						await stream.end();
					}
					return seen;
				});
		};
		const fresh = await answer(true);
		expect(await answer(false)).toBe("200 one");
		// A kept-alive connection would have been re-sent on, to a session
		// already spent: a 404 where the test cut the stream.
		expect(await answer(true)).toBe(fresh);
		expect(fresh).toBe("rejected: TypeError: Failed to fetch");
	});

	it("continues to a URL relative to the request, and answers one Playwright would refuse with the rule's 500", async () => {
		const real = await loopbackServer((request, response) =>
			request.url === "/"
				? response.writeHead(200, { "content-type": "text/html" }).end(HTML)
				: response.end(`reached ${request.url}`),
		);
		const { context, page } = await contextWithPage();
		const stage = createStage({ plugins: [probe], pageFlushMs: 5 });
		await stage.attach(context);
		disposers.push(() => stage.dispose());
		await stage.probe.add({
			label: "relative",
			url: "/api/relative",
			handle: () => ({ type: "continue", url: "v2/thing" }),
		});
		await stage.probe.add({
			label: "to https",
			url: "/api/scheme",
			handle: () => ({ type: "continue", url: "https://127.0.0.1/" }),
		});
		await stage.probe.add({
			label: "bogus abort",
			url: "/api/abort",
			handle: () => ({ type: "abort", error: "bogus" as never }),
		});
		await page.goto(`${real}/`);
		expect(await fetchIn(page, "/api/relative")).toBe(
			"200 reached /api/v2/thing",
		);
		expect(await fetchIn(page, "/api/scheme")).toBe(
			'500 wirestage: rule "to https" failed: continue cannot change the scheme (http: to https:): Playwright rewrites a URL within its scheme only',
		);
		expect(await fetchIn(page, "/api/abort")).toContain(
			'500 wirestage: rule "bogus abort" failed: "bogus" is not an abort error code',
		);
	});

	it("folds a header's several values, where Chromium would leave the page waiting", async () => {
		const { stage, page } = await stageOn([probe]);
		await stage.probe.add({
			label: "multi",
			url: "/api/multi",
			handle: () => ({
				type: "fulfill",
				headers: { "x-multi": "a\nb" },
				body: "x",
			}),
		});
		const seen = await page.evaluate(() =>
			Promise.race([
				fetch("/api/multi").then((response) => response.headers.get("x-multi")),
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("hung"), 1_000),
				),
			]),
		);
		expect(seen).toBe("a, b");
	});

	it("goes on reading while a dialog holds a response's body, and records it once the dialog closes", async () => {
		const origin = await loopbackServer((request, response) =>
			request.url === "/"
				? response
						.writeHead(200, { "content-type": "text/html" })
						.end(
							"<!doctype html><script>window.go = async () => { const r = await fetch('/api/data'); await r.text(); alert('done'); };</script>",
						)
				: response
						.writeHead(200, { "content-type": "application/json" })
						.end('{"ok":true}'),
		);
		const context = await newContext();
		const page = await context.newPage();
		const stage = createStage({
			plugins: [rest({ baseURL: "/api", record: true })],
			pageTimeoutMs: 300,
		});
		await stage.attach(context);
		disposers.push(() => stage.dispose());
		await page.goto(`${origin}/`);
		const dialog = new Promise<import("@playwright/test").Dialog>((resolve) =>
			page.once("dialog", resolve),
		);
		await page.evaluate(() => {
			void (window as unknown as { go(): Promise<void> }).go();
		});
		const open = await dialog;
		const started = Date.now();
		const during = await Promise.race([
			stage.rest.calls(),
			new Promise<"hung">((resolve) =>
				setTimeout(() => resolve("hung"), 5_000),
			),
		]);
		expect(during).not.toBe("hung");
		// The page's own flush and the body each wait a page timeout at most.
		expect(Date.now() - started).toBeLessThan(2_000);
		await open.dismiss();
		await expect
			.poll(async () => (await stage.rest.calls())[0]?.response?.payload.text())
			.toBe('{"ok":true}');
	});

	it("gives up a stream whose page let go while its rule decided, or closed after the redirect", async () => {
		const { context, page } = await contextWithPage();
		const timeline = createTimeline({ clock: createSystemClock() });
		const real = createStreamServer();
		disposers.push(() => real.close());
		const ports = new Set<string>();
		const router = createHttpRouter({
			timeline,
			log: createScopedLogger("Http"),
			streams: {
				open: async (handler, options) => {
					const session = await real.open(handler, options);
					ports.add(new URL(session.url).port);
					return session;
				},
			},
			pageId: () => "p1",
			correlation: createSequence("x"),
			clock: createSystemClock(),
			timeoutMs: 300,
		});
		const attachment = {
			id: "c1",
			baseURL: undefined,
			cookies: context,
			context,
		};
		await router.attach(attachment);
		disposers.push(() => router.detach(attachment));
		let release: () => void = () => {};
		const handle = await router.add({
			protocol: "probe",
			label: "stream",
			url: "/events",
			async handle() {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return { type: "stream", open: (stream) => stream.flush() };
			},
		});
		await page.goto(`${ORIGIN}/`);
		for (let round = 1; round <= 5; round++) {
			await page.evaluate(() => {
				(globalThis as unknown as { source: EventSource }).source =
					new EventSource("/events");
			});
			await expect.poll(() => handle.hits).toBe(round);
			// The app changes its mind while the rule is still deciding.
			await page.evaluate(() =>
				(globalThis as unknown as { source: EventSource }).source.close(),
			);
			release();
			// Its end is on record, and its place on the stream server free.
			await expect
				.poll(() => timeline.frames({ kind: "fault" }).length)
				.toBe(round);
			expect(real.sessions).toBe(0);
		}
		// Every place it took was given back: one port served them all.
		expect(ports.size).toBe(1);
		expect(
			timeline.frames({ kind: "fault" }).map((frame) => frame.meta),
		).toEqual(
			Array.from({ length: 5 }, () => ({
				reason: "network",
				error: "net::ERR_ABORTED",
			})),
		);
		// A page that closes says nothing of its requests: the deadline does.
		const popup = await context.newPage();
		await popup.goto(`${ORIGIN}/`);
		await popup.evaluate(() => {
			new EventSource("/events");
		});
		await expect.poll(() => handle.hits).toBe(6);
		await popup.close();
		release();
		await expect.poll(() => timeline.frames({ kind: "fault" }).length).toBe(6);
		expect(real.sessions).toBe(0);
		expect(timeline.last()?.meta).toEqual({
			reason: "unreached",
			error:
				"the browser did not bring the request to the stream server within 300 ms",
		});
	});

	it("settles every send that races the page's close of its EventSource", async () => {
		const { stage, page } = await stageOn([sse()]);
		const stub = await stage.sse.stream("/events");
		const outcomes: Promise<string>[] = [];
		for (let round = 0; round < 6; round++) {
			await page.evaluate(() => {
				(globalThis as unknown as { source: EventSource }).source =
					new EventSource("/events");
			});
			const connection = await stub.next({ timeout: 10_000 });
			await connection.send("hello");
			let closed = false;
			void connection.closed.then(() => {
				closed = true;
			});
			const closing = page.evaluate(() =>
				(globalThis as unknown as { source: EventSource }).source.close(),
			);
			// Send as fast as the loop turns until the close is known.
			await new Promise<void>((resolve) => {
				const send = () => {
					outcomes.push(
						Promise.race([
							connection.send("x").then(
								() => "sent",
								(error: { code?: string }) => `refused ${error.code}`,
							),
							new Promise<string>((done) =>
								setTimeout(() => done("never settled"), 3_000),
							),
						]),
					);
					if (closed) resolve();
					else setImmediate(send);
				};
				send();
			});
			await closing;
		}
		const settled = await Promise.all(outcomes);
		expect(settled).toContain("refused CLOSED");
		expect(settled).not.toContain("never settled");
	});
});

describe("local-network-access in Chromium", () => {
	/** Record the stage's grants, and make them all the same. */
	const watchGrants = (context: BrowserContext) => {
		const grants: unknown[] = [];
		const grant = context.grantPermissions.bind(context);
		context.grantPermissions = async (permissions, options) => {
			grants.push(
				options === undefined ? [permissions] : [permissions, options],
			);
			await grant(permissions, options);
		};
		return grants;
	};
	const states = (page: Page) =>
		page.evaluate(async () => {
			const out: Record<string, string> = {};
			for (const name of ["geolocation", "notifications"])
				out[name] = (
					await navigator.permissions.query({ name: name as PermissionName })
				).state;
			return out;
		});
	const streamArrives = async (
		page: Page,
		stub: { next(options: { timeout: number }): Promise<unknown> },
	) => {
		await page.evaluate(() => {
			new EventSource("/events");
		});
		return stub.next({ timeout: 3_000 }).then(
			() => "arrived",
			() => "never arrived",
		);
	};

	it("grants a page a route served its own origin, per stream, next to the test's grants for it", async () => {
		const { context, page } = await contextWithPage();
		const grants = watchGrants(context);
		// The test's own grant, made before the first stream.
		await context.grantPermissions(["geolocation"], { origin: ORIGIN });
		const stage = createStage({ plugins: [sse()] });
		await stage.attach(context);
		disposers.push(() => stage.dispose());
		await page.goto(`${ORIGIN}/`);
		const stub = await stage.sse.stream("/events");
		expect(await streamArrives(page, stub)).toBe("arrived");
		// Playwright merged the two for the origin: the test's grant stands.
		expect(await states(page)).toEqual({
			geolocation: "granted",
			notifications: "denied",
		});
		// One made after the first stream, and a clear, leave later ones be.
		await context.grantPermissions(["notifications"], { origin: ORIGIN });
		expect(await streamArrives(page, stub)).toBe("arrived");
		await context.clearPermissions();
		expect(await streamArrives(page, stub)).toBe("arrived");
		expect(grants).toEqual([
			[["geolocation"], { origin: ORIGIN }],
			[["local-network-access"], { origin: ORIGIN }],
			[["notifications"], { origin: ORIGIN }],
			[["local-network-access"], { origin: ORIGIN }],
			[["local-network-access"], { origin: ORIGIN }],
		]);
	});

	it("leaves the permissions of a page a loopback server served as they were: it needs no grant", async () => {
		const origin = await loopbackServer((_request, response) =>
			response.writeHead(200, { "content-type": "text/html" }).end(HTML),
		);
		const context = await newContext();
		const grants = watchGrants(context);
		const page = await context.newPage();
		const stage = createStage({ plugins: [sse()] });
		await stage.attach(context);
		disposers.push(() => stage.dispose());
		await page.goto(`${origin}/`);
		const before = await states(page);
		const stub = await stage.sse.stream("/events");
		expect(await streamArrives(page, stub)).toBe("arrived");
		expect(await states(page)).toEqual(before);
		expect(before).toEqual({ geolocation: "prompt", notifications: "prompt" });
		expect(grants).toEqual([]);
	});

	it("grants nothing to a page that is not a secure context, which Chromium never lets reach loopback", async () => {
		const origin = "http://app.test";
		const { context, page } = await contextWithPage(origin);
		const grants = watchGrants(context);
		const stage = createStage({ plugins: [sse()] });
		await stage.attach(context);
		disposers.push(() => stage.dispose());
		await page.goto(`${origin}/`);
		const stub = await stage.sse.stream("/events");
		expect(await streamArrives(page, stub)).toBe("never arrived");
		expect(grants).toEqual([]);
		// The exchange ends with what the browser said, not with nothing.
		const faults = await stage.frames({ protocol: "sse", kind: "fault" });
		expect(faults.length).toBeGreaterThan(0);
		for (const fault of faults)
			expect(fault.meta).toEqual({
				reason: "network",
				error: "net::ERR_FAILED",
			});
	});

	it("leaves a page that needs the grant only what the test granted its origin: context-wide grants are lost there", async () => {
		const { context, page } = await contextWithPage(ORIGIN, {
			permissions: ["geolocation"],
		});
		const stage = createStage({ plugins: [sse()] });
		await stage.attach(context);
		disposers.push(() => stage.dispose());
		await page.goto(`${ORIGIN}/`);
		expect((await states(page))["geolocation"]).toBe("granted");
		const stub = await stage.sse.stream("/events");
		expect(await streamArrives(page, stub)).toBe("arrived");
		// Chromium takes an origin's grants for all it may do there.
		expect(await states(page)).toEqual({
			geolocation: "denied",
			notifications: "denied",
		});
	});
});
