# An HTTP/2 proxy for the browser under test

Over HTTP/1.1 Chromium keeps six connections per origin, and a response that
stays open — a server stream, an event stream, a long poll — holds one for as
long as it runs. A page that holds six leaves every other request to that
origin queued for good: the page draws, then goes still, and the test fails
on whatever it waited for next. Production rarely sees it, because an HTTP/2
edge multiplexes every request on one connection; a dev server, or `vite
preview`, speaks HTTP/1.1.

`@heojeongbo/wirestage/h2-proxy` puts that edge in front of the browser. It is
not a plugin: it is a loopback HTTPS proxy that speaks HTTP/2 to Chromium and
HTTP/1.1 to each server, so every request is one stream of one connection.
The page's origin, cookies and `Host` are what they were.

## Setting it up

Chromium learns of a proxy at launch, from flags a Playwright config sets
before anything has started, so the port is fixed and the proxy starts in a
global setup.

```ts
// proxy.ts
/** The port the browser's flags name and the global setup listens on. */
export const PROXY_PORT = 9443;
```

```ts
// playwright.config.ts
import { h2ProxyArgs } from "@heojeongbo/wirestage/h2-proxy";
import { defineConfig } from "@playwright/test";

import { PROXY_PORT } from "./proxy.js";

export default defineConfig({
	globalSetup: "./global-setup.ts",
	use: { launchOptions: { args: h2ProxyArgs(PROXY_PORT) } },
});
```

```ts
// global-setup.ts
import { startH2Proxy } from "@heojeongbo/wirestage/h2-proxy";

import { PROXY_PORT } from "./proxy.js";

export default async function globalSetup(): Promise<() => Promise<void>> {
	const proxy = await startH2Proxy({ port: PROXY_PORT });
	return () => proxy.close();
}
```

`h2ProxyArgs` gives three flags: the proxy, `--proxy-bypass-list=<-loopback>`
(Chromium never proxies localhost on its own, and that is where an app under
test usually is), and `--ignore-certificate-errors`. They are flags rather
than Playwright's `proxy` option, which `route.fetch()` and `context.request`
would go through too, and fail on the proxy's certificate. Those two still go
straight to the server.

## What it carries

- A plain-http request is sent on to its authority as it came, its body
  streamed both ways. A server that cuts a response short resets the stream,
  which the page reads as the network error a cut HTTP/1.1 body gives it; a
  page that lets go of a stream ends the request it rode on, so the server
  sees the viewer leave.
- A `CONNECT` — a WebSocket, an https origin — is tunnelled as bytes.
- A server it cannot reach answers 502.

Requests a route answers never reach the network, so they never reach the
proxy either. Only Chromium is covered: Firefox and WebKit take no such flags.

## Editing documents

```ts
import { startH2Proxy } from "@heojeongbo/wirestage/h2-proxy";

export const proxy = await startH2Proxy({
	port: 9443,
	transformHtml: (html) =>
		html.replace("<head>", '<head><meta name="under-test" content="yes">'),
});
```

`transformHtml` edits the HTML document every navigation gets, in every
context of every browser that uses the proxy — contexts no stage is attached
to included. The proxy asks for those documents uncompressed; a response that
is compressed anyway, is not HTML, or is a download goes on untouched, and an
edit that throws answers 502 rather than half a page.

## The certificate

Chromium speaks HTTP/2 to an HTTPS proxy, so the proxy needs a certificate.
Without `tls: { key, cert }` it makes a self-signed one for the run with
`openssl`, which it then needs on `PATH`; the browser accepts it through
`--ignore-certificate-errors`, as it would any other, which a test browser
can afford.
