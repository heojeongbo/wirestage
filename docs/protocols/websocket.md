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
- After a connection is over, `send`, `toPage` and `toServer` throw `CLOSED`,
  and `broadcast` skips it.
- An `onConnect` that throws closes the page's socket with 1011 and records a
  `fault` frame (`meta.reason: "rule-error"`).

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
