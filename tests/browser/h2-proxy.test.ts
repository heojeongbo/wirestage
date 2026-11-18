/**
 * The HTTP/2 proxy against a real Chromium: the browser speaks h2 to it, a
 * page holding more open responses than HTTP/1.1's six connections per origin
 * still gets its next request answered, and a navigation's document comes
 * back edited.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { type Browser, chromium } from "@playwright/test";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { type H2Proxy, startH2Proxy } from "../../src/h2-proxy.js";

/** Open responses the page holds: two more than HTTP/1.1 gives one origin. */
const OPEN = 8;

const cleanups: (() => Promise<unknown> | unknown)[] = [];
let browser: Browser | undefined;
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(async () => {
	await browser?.close();
});

/**
 * An app on a plain HTTP/1.1 server: a page, responses that stay open (a
 * watch each), and one ordinary request to make after them.
 */
async function app(): Promise<string> {
	const open = new Set<ServerResponse>();
	const server = createServer((request, response) => {
		if (request.url === "/") {
			response.writeHead(200, { "content-type": "text/html" });
			response.end(
				"<!doctype html><html><head><title>rooms</title></head><body></body></html>",
			);
			return;
		}
		if (request.url?.startsWith("/watch/")) {
			response.writeHead(200, { "content-type": "text/plain" });
			response.write("open\n");
			open.add(response);
			return;
		}
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("after");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				for (const response of open) response.destroy();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let direct: Browser | undefined;
afterAll(async () => {
	await direct?.close();
});

async function through(proxy: H2Proxy | undefined) {
	// One browser each way, launched on first use: the proxy's flags are fixed
	// at launch.
	if (proxy === undefined) direct ??= await chromium.launch();
	else browser ??= await chromium.launch({ args: [...proxy.chromiumArgs] });
	const launched = (proxy === undefined ? direct : browser) as Browser;
	const context = await launched.newContext();
	cleanups.push(() => context.close());
	return context.newPage();
}

/**
 * Opens OPEN watches at once, then one ordinary request: what each got, or
 * that it was still waiting after `wait` ms.
 */
function holdOpenThenAsk(
	page: Awaited<ReturnType<typeof through>>,
	wait: number,
) {
	return page.evaluate(
		async ({ open, wait }) => {
			const late = <T>(value: T) =>
				new Promise<T>((resolve) => setTimeout(() => resolve(value), wait));
			const watches = Array.from({ length: open }, (_, i) =>
				fetch(`/watch/${i}`).then(async (response) => {
					const reader = (
						response.body as ReadableStream<Uint8Array>
					).getReader();
					await reader.read();
					return reader;
				}),
			);
			const opened = await Promise.race([
				Promise.all(watches),
				late(undefined),
			]);
			if (opened === undefined) return { opened: false };
			const after = await Promise.race([
				fetch("/after").then((response) => response.text()),
				late("queued"),
			]);
			const entry = performance
				.getEntriesByType("resource")
				.find((e) => e.name.endsWith("/after")) as
				| PerformanceResourceTiming
				| undefined;
			for (const reader of opened) void reader.cancel();
			return { opened: true, after, protocol: entry?.nextHopProtocol };
		},
		{ open: OPEN, wait },
	);
}

describe("the HTTP/2 proxy", () => {
	it("without it, a page holding more than six open responses to one origin waits for good", async () => {
		const origin = await app();
		const page = await through(undefined);
		await page.goto(origin);
		expect(await holdOpenThenAsk(page, 2_000)).toEqual({ opened: false });
	});

	it("carries the same page past them over h2, and edits the document it navigates to", async () => {
		const origin = await app();
		const proxy = await startH2Proxy({
			transformHtml: (html) =>
				html.replace("<head>", '<head><meta name="proxied" content="yes">'),
		});
		cleanups.push(() => proxy.close());
		const page = await through(proxy);
		await page.goto(origin);
		expect(await page.locator('meta[name="proxied"]').count()).toBe(1);
		expect(await holdOpenThenAsk(page, 5_000)).toEqual({
			opened: true,
			after: "after",
			protocol: "h2",
		});
	});
});
