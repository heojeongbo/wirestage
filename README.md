# wirestage

Record, fake and fault-inject browser wire traffic in Playwright — REST,
Connect, gRPC-web, gRPC, SSE, WebSocket and WebRTC data channels — on one
timeline.

```sh
pnpm add -D @heojeongbo/wirestage
```

Playwright can route HTTP and WebSockets, but a modern app talks more than
that: server-streaming RPCs, event streams, WebRTC data channels. Tests end up
hand-rolling gRPC-web frames, patching `RTCDataChannel` in init scripts and
running ad-hoc local servers for streams. wirestage is those pieces, done once,
behind one API:

- **Fake** any protocol, including responses that stay open: a test-driven
  gRPC-web stream or event stream, message by message.
- **Record** what the page actually sent and received, decoded, on a single
  timeline you can drain, mark and wait on.
- **Fault-inject**: abort, delay, hold, cut a stream mid-flight, drop messages
  on one data channel while it stays open.
- **Drive** the real backend from the test, signed in as the page.

## Quick start

```ts
import { test as base, expect } from "@playwright/test";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { json, rest } from "@heojeongbo/wirestage/rest";
import { webrtc } from "@heojeongbo/wirestage/webrtc";

export const test = withStage(base, {
	plugins: [rest({ baseURL: "/api" }), webrtc({ labels: ["room/cursor"] })],
});

test("the room card shows its state", async ({ page, stage }) => {
	await stage.rest.get("/rooms/:id", (request) =>
		json({ id: request.params["id"], state: "idle" }),
	);
	await page.goto("/rooms/r1");
	await expect(page.getByText("idle")).toBeVisible();

	await stage.mark("before move");
	await page.getByRole("button", { name: "Share cursor" }).click();
	const sent = await stage.since("before move", {
		protocol: "webrtc",
		endpoint: "room/cursor",
		direction: "out",
	});
	expect(sent.length).toBeGreaterThan(0);
});
```

A failing test gets the timeline attached to its report, as text and JSON,
whenever anything is on it.

## Protocols

Each protocol is a plugin in its own subpath. Install only the peers of the
ones you use.

| Subpath | Plugin | Fakes | Records | Faults | Extra peers |
| --- | --- | --- | --- | --- | --- |
| `/rest` | `rest()` | routes with `:params`, `json`/`text`/`bytes` replies and responses that stay open; servers for clients outside the browser | requests and real responses | abort, delay, status | — |
| `/connect` | `connect()` | Connect, gRPC-web: unary, server streams, whole services; a call rewritten on its way to the real backend | decoded messages, request headers and status | fail, abort, hold, cut | `@connectrpc/connect`, `@connectrpc/connect-node`, `@bufbuild/protobuf` |
| `/sse` | `sse()` | event streams driven from the test | events sent | end, cut | — |
| `/websocket` | `websocket()` | a fake server, or a proxy in front of the real one; servers for clients outside the browser, alone or on a REST fake's port | both directions | drop, close, cut | — |
| `/webrtc` | `webrtc()` | inject messages as the peer | every data channel message | suppress either direction | — |

The `connect` plugin also builds typed clients for the real backend
(`stage.connect.client(Service)`, cookies included) and serves stubs on a port
of their own for clients outside the browser — native gRPC over HTTP/2
included (`stage.connect.serve(...)`). `rest` and `websocket` serve fakes for
such clients too, and two of them on one port make one backend: an HTTP API
and its WebSocket (`stage.rest.serve(...)`, `stage.websocket.serve(...)`).

A protocol the library does not ship is a plugin you write against the same
contract the built-in ones use: [docs/plugins.md](docs/plugins.md).

`/h2-proxy` is not a plugin. It is an HTTP/2 proxy for the browser under
test, for an app that holds more open responses than the six connections
Chromium keeps per origin over HTTP/1.1: [docs/h2-proxy.md](docs/h2-proxy.md).

## The timeline

Every plugin writes `Frame`s to the stage's timeline: protocol, direction
(`out` left the page, `in` reached it), endpoint, payload, who produced it,
and an id that ties the frames of one exchange together. Reads bring the
timeline up to date first: they flush what the pages have buffered.

```ts
import type { Stage } from "@heojeongbo/wirestage";

export async function lastCommand(stage: Stage) {
	const frames = await stage.drain({ protocol: "webrtc", direction: "out" });
	return frames.at(-1)?.payload.bytes();
}
```

`frames`, `drain`, `mark`, `since`, `between`, `waitFor` and `report` are
described in [docs/timeline.md](docs/timeline.md).

## Without the fixture

Contexts made with `browser.newContext()` attach the same way:

```ts
import type { Browser } from "@playwright/test";
import { createStage } from "@heojeongbo/wirestage";
import { webrtc } from "@heojeongbo/wirestage/webrtc";

export async function openSession(browser: Browser) {
	const context = await browser.newContext({ baseURL: "http://localhost:3000" });
	const stage = createStage({ plugins: [webrtc()] });
	// Before the first navigation, so the page hooks are in place.
	await stage.attach(context, { baseURL: "http://localhost:3000" });
	return { context, stage, page: await context.newPage() };
}
```

## Documentation

- [Getting started](docs/getting-started.md)
- [The timeline](docs/timeline.md)
- Protocols: [Connect / gRPC-web / gRPC](docs/protocols/connect.md),
  [REST](docs/protocols/rest.md), [SSE](docs/protocols/sse.md),
  [WebSocket](docs/protocols/websocket.md), [WebRTC](docs/protocols/webrtc.md)
- [An HTTP/2 proxy for the browser](docs/h2-proxy.md)
- [Writing a protocol plugin](docs/plugins.md)
- [Architecture](docs/architecture.md) and [design patterns](docs/design-patterns.md)
- [Testing](docs/testing.md), [performance](docs/performance.md),
  [logging](docs/logging.md), [troubleshooting](docs/troubleshooting.md)

## Compatibility

- **Node 22.12 or later.** The package is ES modules. A CommonJS project loads
  it with `require()`, which Node supports from that version; that is how
  Playwright runs the tests of a project without `"type": "module"`.
- **Playwright 1.50 or later** — the one required peer. The suite runs
  against 1.60 in Chromium.
- **TypeScript 5.0 or later**, with `moduleResolution` set to `node16`,
  `nodenext` or `bundler` (the entry points are published through `exports`),
  and `@types/node`, as in any Playwright project.
- Live streams (server streams, SSE, REST `stream()` replies) redirect the
  page's request to a local server; see
  [troubleshooting](docs/troubleshooting.md) for https pages.

## Developing

Everything runs in the devcontainer, which is the Playwright image for the
pinned version: `pnpm check` and `pnpm check:browser`
([docs/testing.md](docs/testing.md)). Its `node_modules` is a volume, so the
host has none: run `pnpm install` on the host as well if you want editor
type-checking and the git hooks there.

## License

MIT
