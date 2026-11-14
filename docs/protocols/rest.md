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

- Paths take `:name` params, `*` for one segment and `**` for any number,
  relative to `baseURL`; a pattern with a scheme
  (`https://api.example.test/x`) matches origin and path. A RegExp matches
  the path, and its named groups become `params`.
- The query never takes part in matching, so a route for `/search` answers
  `/search?q=x`; read it from `request.query`. A `?` in a path is refused
  rather than left to never match.
- Replies: `json`, `text`, `bytes`, `empty`, `passthrough`, `abort(code)`,
  `delay(ms, reply)`. A resolver may be one, or compute one from the request.
- Every route takes `times` and `match`. The newest route that matches wins;
  one that steps aside (`match` said no, `times` ran out, `passthrough()`)
  leaves the request to the next, and then to the network.
- `stage.rest.calls({ method, path })` pairs each request with its response.
  A request is one call however many routes saw it; `call.response.source` is
  `stub` or `network`, and `call.status` is `undefined` for a request that
  was aborted or has not finished.
- A resolver that throws answers the page with a 500 naming the route, and
  logs the error: a bug in a test must not look like a hung request.
