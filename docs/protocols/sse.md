# Server-sent events

```ts
import { test as base, expect } from "@playwright/test";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { sse } from "@heojeongbo/wirestage/sse";

const test = withStage(base, { plugins: [sse()] });

test("the feed reconnects", async ({ page, stage }) => {
	const feed = await stage.sse.stream("/events", { retry: 100 });
	await page.goto("/");
	const first = await feed.next();
	await first.send({ id: "1", event: "tick", data: { n: 1 } });
	await first.end();
	const second = await feed.next();
	expect(second.lastEventId).toBe("1");
});
```

- `send` takes a string (sent as `data`) or `{ data, event, id, retry, comment }`;
  non-string data is sent as JSON, multi-line data as several `data:` lines.
  It resolves once the event is written, and rejects with `CLOSED` when the
  connection is over.
- `end()` closes cleanly. An `EventSource` reconnects after its retry delay,
  through your route again, carrying `Last-Event-ID` — read it as
  `connection.lastEventId` (the browser adds the header after Playwright's
  route sees the request, so `request.headers` does not have it).
- `cut()` resets the connection. **In Chromium an EventSource whose request
  Playwright redirected treats a reset as fatal and closes for good**
  (`readyState` 2). Use `end()` to test reconnects, `cut()` to test giving up.
- `connection.closed` resolves with `ended`, `cut` or `cancelled` (the page
  closed it, navigated or went away). The timeline has the same: a `lifecycle`
  frame for an end, a `fault` with `meta.reason: "cut"` for a cut.
- `stream` takes `times`, `match`, `status`, `headers` and `retry`;
  `stub.broadcast(event)` sends to every open connection, and
  `stage.sse.events()` lists what was sent.
- Any number of connections can be open at once: the stream server spreads
  them over several ports, because a browser opens only six connections to
  one.
