import { listenH2Proxy } from "../../../shared/api/h2-proxy/index.js";
import type { H2Proxy, H2ProxyOptions } from "../model/types.js";

/**
 * Start a loopback HTTP/2 proxy for a browser under test.
 *
 * Over HTTP/1.1 Chromium keeps six connections per origin, and a response
 * that stays open — a server stream, an event stream, a long poll — holds
 * one for as long as it runs. A page holding six leaves every other request
 * to that origin queued for good: the page draws, then goes still. Through
 * this proxy the browser speaks HTTP/2, as it would to a production edge, and
 * every request is one stream of one connection; the proxy sends each on over
 * HTTP/1.1, where Node keeps no such limit. The page's origin, cookies and
 * `Host` are what they were.
 *
 * Start it before the browser's first request (a global setup), on the port
 * the launch flags name.
 */
export async function startH2Proxy(
	options: H2ProxyOptions = {},
): Promise<H2Proxy> {
	const listening = await listenH2Proxy(options);
	return {
		url: listening.url,
		port: listening.port,
		chromiumArgs: h2ProxyArgs(listening.port, options.host),
		close: () => listening.close(),
	};
}

/**
 * The Chromium flags for a proxy on `port`: for `launchOptions.args`, which a
 * Playwright config sets before any proxy has started.
 *
 * Flags rather than Playwright's `proxy` option, which `route.fetch()` and
 * `context.request` would go through too, and fail on the proxy's
 * certificate. `<-loopback>` takes back Chromium's own rule of never proxying
 * localhost, where an app under test usually is; the certificate is accepted
 * as any would be, which a test browser can afford.
 */
export function h2ProxyArgs(port: number, host = "127.0.0.1"): string[] {
	return [
		`--proxy-server=https://${host.includes(":") ? `[${host}]` : host}:${port}`,
		"--proxy-bypass-list=<-loopback>",
		"--ignore-certificate-errors",
	];
}
