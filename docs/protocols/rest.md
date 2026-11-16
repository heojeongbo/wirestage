# REST

```ts
import { test as base, expect } from "@playwright/test";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { empty, json, passthrough, rest, text } from "@heojeongbo/wirestage/rest";

const test = withStage(base, { plugins: [rest({ baseURL: "/api/v1", record: true })] });

test("routes", async ({ page, stage }) => {
	const room = await stage.rest.get("/rooms/:id", (request) =>
		json({ id: request.params["id"], verbose: request.query.get("verbose") === "1" }),
	);
	await stage.rest.post("/rooms", async (request) => json(request.json(), { status: 201 }));
	await stage.rest.delete("/rooms/:id", empty());
	await stage.rest.get("/health", text("ok"), { times: 1 });
	await stage.rest.on("*", "/legacy/**", passthrough());
	await page.goto("/");
	await expect(room.next()).resolves.toMatchObject({ method: "GET" });
});
```

| Option | Default | |
| --- | --- | --- |
| `baseURL` | none | A path prefix (`/api/v1`) or an origin (`https://api.example.test`) that routes are relative to. |
| `record` | off | Record requests no route answers, with their real responses: `true` for everything under `baseURL`, or a URL matcher. |

- Paths take `:name` params, `*` for one segment, `**` for any number (so
  `/a/**/b` matches `/a/b` too) and `{a,b}` for either — the glob every URL
  pattern of the library takes — relative to `baseURL`; a pattern with a scheme
  (`https://api.example.test/x`) matches origin and path. A RegExp matches
  the path, and its named groups become `params`.
- The query never takes part in matching, so a route for `/search` answers
  `/search?q=x`; read it from `request.query`. A `?` in a path is refused
  rather than left to never match.
- Replies: `json`, `text`, `bytes`, `empty`, `stream(open)`, `passthrough`,
  `abort(code)`, `delay(ms, reply)`. A resolver may be one, or compute one
  from the request.
- Every route takes `times` and `match`. The newest route that matches wins;
  one that steps aside (`match` said no, `times` ran out, `passthrough()`)
  leaves the request to the next, and then to the network.
- `stage.rest.calls({ method, path })` pairs each request with its response.
  A request is one call however many routes saw it; `call.response.source` is
  `stub` or `network`, and `call.status` is `undefined` for a request that
  was aborted or has not finished.
- A resolver that throws answers the page with a 500 naming the route, and
  logs the error: a bug in a test must not look like a hung request.

## Responses that stay open

`stream(open, { status, headers, contentType })` answers with a response the
test writes as it goes: a watch, a log that follows, a long poll. A page's
route and a served fake's (below) take it alike.

```ts
import { createStage } from "@heojeongbo/wirestage";
import { type RestStream, rest, stream } from "@heojeongbo/wirestage/rest";

export async function fakeWatch() {
	const stage = createStage({ plugins: [rest()] });
	const server = await stage.rest.serve({ name: "fake scheduler" });
	const watches: RestStream[] = [];
	await server.get(
		"/v1/events",
		stream(
			async (watch) => {
				watches.push(watch);
				// A heartbeat, so the client knows it is connected.
				await watch.write("{}\n");
			},
			{ contentType: "application/x-ndjson" },
		),
	);
	// …later: await watches[0]?.write(event), then end() or cut() it.
	return { stage, server, watches };
}
```

- The head goes out at once: 200 unless `status` says otherwise,
  `application/octet-stream` unless `contentType` does. `open` then writes
  the body with `write(chunk)` and ends it with `end()`, or `cut()`s the
  connection as a network drop would. `open` may return long before that:
  the response stays open until it is ended, cut, or let go of.
- `closed` resolves with how it ended — `ended`, `cut`, or `cancelled` when
  the client let go of it or its server closed — once that is on the
  timeline. A `write` after it rejects with `CLOSED`.
- On the timeline, the head is the exchange's `response`, so `calls()` has
  the status while the stream is still open; each chunk is a `message`, and
  the end a `lifecycle` close or a `cut` fault.
- The head is out before `open` runs, so an `open` that throws cuts the
  connection, on record as the route's `rule-error`. A status no head can
  carry answers 500, as a resolver that throws does.
- A page's stream is redirected to the stage's local stream server, as SSE
  and server streams are; see [troubleshooting](../troubleshooting.md) for
  https pages.

## Fakes for clients outside the browser

A service under test, an agent or a CLI talks to its HTTP backends itself, not
through the page. `serve()` gives such a client a backend of the test's
making, with the same routes, replies and recording as the page's:

```ts
import { createStage } from "@heojeongbo/wirestage";
import { json, rest } from "@heojeongbo/wirestage/rest";

export async function fakeMetrics() {
	const stage = createStage({ plugins: [rest()] });
	const metrics = await stage.rest.serve({ port: 8081, name: "fake metrics" });
	const queries = await metrics.post("/query", (request) =>
		json({ rows: [], echoed: request.text().length }),
	);
	// …start the client, which sends POST http://127.0.0.1:8081/query…
	await queries.next(); // its first query arrived
	const calls = await metrics.calls({ path: "/query" });
	return { stage, calls };
}
```

- `serve({ port, host, name, baseURL })`: a fixed `port` that is taken fails
  with a message naming the server; 0, the default, picks a free one. A port
  one of the same stage's WebSocket fakes listens on (`websocket.serve()`) is
  shared instead: plain requests come here, WebSocket handshakes go there —
  one backend with an API and a socket on one port.
  `baseURL` is a path prefix the routes are relative to.
- Routes are tried newest first, as the page's are. `passthrough()` hands the
  request to the next older route; with none left, the server answers 404.
  `times`, `match`, `delay` and `abort` behave as they do for the page.
- Each exchange is on the timeline: the request as `source: "network"`, the
  answer as `source: "server"`, both with `meta.server` set to the server's
  URL. `stage.rest.calls()` lists them with the page's; a call's `server` says
  which fake received it, and `server.calls()` lists only its own.
- A request a served fake received has no `page`, an empty `context` and the
  `resourceType` `other`. The stage closes its servers when it is disposed.
