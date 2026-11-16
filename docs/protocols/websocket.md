# WebSocket

```ts
import { test as base, expect } from "@playwright/test";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { websocket } from "@heojeongbo/wirestage/websocket";

const test = withStage(base, { plugins: [websocket()] });

test("a fake server", async ({ page, stage }) => {
	const live = await stage.websocket.mock("/live", {
		onConnect: (connection) => connection.send({ hello: true }),
	});
	await page.goto("/");
	const connection = await live.next();
	const first = await connection.nextMessage();
	expect(first.json()).toEqual({ subscribe: "rooms" });
	connection.send("update");
	await connection.close({ code: 1001, reason: "restarting" });
});

test("a proxy that drops", async ({ page, stage }) => {
	const feed = await stage.websocket.proxy("/live", {
		drop: (message) => message.direction === "in" && message.text().includes("heartbeat"),
	});
	await page.goto("/");
	const connection = await feed.next();
	connection.toPage("as the server");
	connection.toServer("as the page");
	const faults = (await stage.websocket.frames()).filter((frame) => frame.kind === "fault");
	expect(faults.every((frame) => frame.meta["reason"] === "dropped")).toBe(true);
});
```

- `mock` plays the server; `proxy` passes through to the real one, recording
  both directions, and can drop messages or inject them (`toPage`, `toServer`).
  Both take `times`. The newest rule that matches a socket takes it; a socket
  no rule takes goes to the real server.
- Frames say who spoke: `page` for the app, `network` for the real server,
  `stub` for a mock's messages and a proxy's drops, `test` for what the test
  injects or closes.
- Frames carry `context` but no `page`: Playwright's WebSocket route does not
  say which page opened the socket.
- **Closing.** Whoever closes — the page, the real server or the test —
  `connection.closed` resolves with the code and reason, and the page's socket
  reaches `CLOSED`. `connection.close()` gives the page any code and reason a
  server may send. A proxy closes the real server's end through the browser,
  which sends only 1000 and 3000-4999 and a reason of at most 123 bytes: any
  other code reaches the server as 1000, and a longer reason is cut.
- After a connection is over, `send`, `toPage` and `toServer` throw `CLOSED`.
  A mock's `connection.open` says whether it still is, and `broadcast` sends
  to the open ones only and returns how many that was.
- An `onConnect`, or a proxy's `drop`, that throws closes the page's socket
  with 1011 and records a `fault` frame (`meta.reason: "rule-error"`).

## When routing starts

Playwright routes WebSockets by replacing `WebSocket` in every document as it
loads. With the plugin on the list that happens from `attach`, so a `mock()`
added after `goto` reaches the page that is already open; sockets no rule
takes are passed through.

`websocket({ lazy: true })` leaves `WebSocket` alone until the first `mock()`
or `proxy()`. That rule then applies only to documents loaded after it.

Playwright cannot remove a WebSocket route, so `remove()` and `detach()` stop
the rule from matching: new connections go to the real server again, and open
ones stay as they are.

## Fakes for clients outside the browser

A service under test or an agent opens its own WebSockets, not through the
page. `serve()` gives such a client a server of the test's making, recorded on
the stage's timeline like the page's sockets:

```ts
import { createStage } from "@heojeongbo/wirestage";
import { json, rest } from "@heojeongbo/wirestage/rest";
import { websocket } from "@heojeongbo/wirestage/websocket";

export async function fakeLogs() {
	const stage = createStage({ plugins: [rest(), websocket()] });
	// One backend, one port: its HTTP API and its WebSocket tail.
	const api = await stage.rest.serve({ port: 8090, name: "fake logs" });
	await api.get("/query", json({ lines: [] }));
	const sockets = await stage.websocket.serve({ port: 8090, name: "fake logs" });
	const tails = await sockets.mock("/tail");
	// …start the client, which opens ws://127.0.0.1:8090/tail?q=…
	const tail = await tails.next();
	tail.send(JSON.stringify({ line: "started" }));
	tail.cut(); // as a dead peer would: no close frame
	return stage;
}
```

- `serve({ port, host, name })`: a fixed `port` that is taken fails with a
  message naming the server; 0, the default, picks a free one.
- **One port for both.** A port one of the same stage's REST fakes
  (`rest.serve()`) listens on is shared: WebSocket handshakes go to the
  WebSocket server, plain requests to the REST one, whichever was served
  first. A port with no REST fake answers a plain request with 426. Each
  half closes on its own; the port closes with the last.
- `mock(url, { times, onConnect })` takes connections as the page's mock
  does; `url` is matched against `ws://host:port/path?query`, and a glob that
  starts with `/` matches the path. Rules are tried newest first. A handshake
  no rule takes is refused with 404 and recorded as a `fault` with
  `meta.reason: "unmatched"`.
- A served connection is a mock's connection plus `cut()`: the TCP connection
  goes with no close frame, and the client sees an abnormal closure, 1006.
  `close()` sends any code a server may (1000-1003, 1007-1014, 3000-4999),
  with the reason cut to the 123 bytes a close frame has room for, and waits
  for the client's answer — at most a second, then the connection is dropped.
  `closed` says 1005 for a close frame with no code and 1006 for a connection
  that ended without one.
- Frames say who spoke: `network` for the client, `server` for the fake, each
  with `meta.server` set to the server's URL. The open frame's `meta` has the
  URL, the handshake's headers and the subprotocol agreed on; a cut is a
  `fault` with `meta.reason: "cut"`. `server.frames()` lists the server's own,
  and `stage.websocket.frames()` everyone's.
- The server speaks RFC 6455 version 13 itself, with no dependency: it agrees
  on the first subprotocol the client offers, answers pings, offers no
  extensions (a client's `permessage-deflate` is declined), and fails a client
  that breaks the protocol with the code for it — 1002, 1007 for text that is
  not UTF-8, 1009 for a message over 100 MiB.
- An `onConnect` that throws closes the connection with 1011 and records a
  `rule-error` fault. The stage closes its servers when it is disposed, and
  cuts what is still open.
- A page can open a socket to a served fake too, but Chromium's Local Network
  Access applies to it as to a live stream (see
  [Troubleshooting](../troubleshooting.md)): a route-fulfilled page needs
  `context.grantPermissions(["local-network-access"], { origin })`.
