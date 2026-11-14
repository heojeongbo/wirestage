# Connect, gRPC-web and gRPC

```sh
pnpm add -D @connectrpc/connect @connectrpc/connect-node @bufbuild/protobuf
```

The examples on this page use this fixtures file. `EchoService` stands in for
your generated services; it has a unary `say`, a server-streaming `watch` and
a side-effect-free `peek`.

```ts
// fixtures.ts
import { test as base } from "@playwright/test";
import { connect } from "@heojeongbo/wirestage/connect";
import { withStage } from "@heojeongbo/wirestage/playwright";

import { EchoService } from "./gen/echo_pb.js";

export const test = withStage(base, {
	plugins: [connect({ baseURL: "/api", record: [EchoService] })],
});
export { expect } from "@playwright/test";
```

| Option | Default | |
| --- | --- | --- |
| `baseURL` | none | What your transport puts in front of `/<pkg>.<Service>/<Method>`: a path prefix, or an origin with one. Without it a stub matches that suffix under any prefix. Also where `client()` calls. |
| `protocols` | `connect`, `grpc-web` | What stubs answer. A browser speaks only these two. |
| `record` | none | Services whose traffic is decoded onto the timeline even when nothing stubs it. |
| `streaming` | `live` | `buffered` collects a stream and answers it at once — for https pages without TLS. |
| `clientProtocol` | `connect` | What `client()` speaks by default. |
| `jsonOptions` | none | protobuf-es JSON options, for stubs and recording. |

## Stubs answer with connect-es's own protocol code

Every stub is a one-method Connect router. The page receives exactly the bytes
a Connect server would send — gRPC-web trailers, Connect error JSON, JSON or
binary as the request asked — so no test hand-builds a frame.

```ts
import { Code } from "@connectrpc/connect";

import { test } from "./fixtures.js";
import { EchoService } from "./gen/echo_pb.js";

test("stubs", async ({ stage }) => {
	// A message, or a function of the decoded request.
	await stage.connect.unary(EchoService.method.say, (request) => ({
		text: `hello ${request.text}`,
	}));
	await stage.connect.fail(EchoService.method.peek, Code.PermissionDenied, "not yours");
	// A network failure, for the next call only.
	await stage.connect.abort(EchoService.method.say, { times: 1 });
	// The methods given; the rest of the service is left alone.
	await stage.connect.service(EchoService, {
		peek: (request) => ({ text: request.text }),
	});
});
```

Unstubbed methods, and requests a stub's `match` rejects, pass through to the
real backend. Stubs added later win, so one test can override a suite-wide one.

Every stub takes `times`, `delayMs` and `match`. `match` gets the decoded
request message, and the raw request for its headers, so a stub can answer one
key, one id or one caller and leave the rest to the backend:

```ts
import { Code } from "@connectrpc/connect";

import { test } from "./fixtures.js";
import { EchoService } from "./gen/echo_pb.js";

test("narrowed stubs", async ({ stage }) => {
	await stage.connect.unary(EchoService.method.say, { text: "for ada" }, {
		match: (request) => request.text === "ada",
	});
	await stage.connect.fail(EchoService.method.say, Code.Unavailable, "", {
		match: (_request, view) => view.headers["x-tenant"] === "team-b",
		delayMs: 200,
	});
});
```

A request that does not decode never matches.

What a stub can answer is what a browser can send: unary and server-streaming
calls, over Connect or gRPC-web, binary or JSON. Client-streaming and
bidirectional methods are refused by `service()` and belong to
[`serve()`](#fakes-for-clients-outside-the-browser). `grpc-web-text` is
recorded, not stubbed.

## Driving a stream from the test

```ts
import { expect, test } from "./fixtures.js";
import { EchoService } from "./gen/echo_pb.js";

test("the list follows the stream", async ({ page, stage }) => {
	const watch = await stage.connect.stream(EchoService.method.watch);
	await page.goto("/");
	const call = await watch.next(); // the page opened the stream
	await call.send({ text: "first" });
	await expect(page.getByText("first")).toBeVisible();
	await call.cut(); // a network drop: no status, no trailer
	await expect(page.getByText("reconnecting")).toBeVisible();
	const again = await watch.next(); // the app's reconnect
	await again.end(); // OK status
});
```

`send`, `end`, `fail(code, message)` and `cut` resolve once they are carried
out; `call.closed` resolves with how the call ended: `ended`, `failed`, `cut`,
or `cancelled` when the page let go of it.

Like a real Connect server, the response headers go out with the first
message, so a page's `fetch()` resolves only after the first `send`. A test
that waits for something the page does after `fetch` resolves must send first.

Live streams are answered from a local server the page's request is redirected
to. See [troubleshooting](../troubleshooting.md) for https pages.

## Holding a call

```ts
import { expect, test } from "./fixtures.js";
import { EchoService } from "./gen/echo_pb.js";

test("the button waits for the answer", async ({ page, stage }) => {
	const hold = await stage.connect.hold(EchoService.method.say);
	await page.goto("/");
	await page.getByRole("button", { name: "Send" }).click();
	const held = await hold.next();
	await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
	await held.reply({ text: "done" });
});
```

A held call is decided once: `reply(message)`, `fail(code)`, `abort()`, or
`release()`, which lets it go on to the next stub that matches and to the
real backend when there is none. `hold.releaseAll()` lets go of every held
call and of every later one: a gate that a slow backend opens.

## What was called

```ts
import { expect, test } from "./fixtures.js";
import { EchoService } from "./gen/echo_pb.js";

test("the page says hello once", async ({ page, stage }) => {
	await page.goto("/");
	const calls = await stage.connect.calls(EchoService.method.say);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.request?.text).toBe("hello");
	expect(calls[0]?.status?.code).toBe(0);
	expect(calls[0]?.answeredBy).toBe("network");
});
```

One request is one call, however many stubs and recorders saw it.

| Field | |
| --- | --- |
| `caller` | Who made it: `page`, `test` (a drive client), `network` (a client outside the browser calling a served fake). |
| `answeredBy` | Who answered: `stub`, `network` (the real backend), `server` (a served fake); `undefined` while nobody has. |
| `status` | `{ code, message }`, code 0 for OK; `undefined` while the call is open, and when it ended in a fault. |
| `fault` | Why it ended without a status: `abort`, `cut`, `cancelled`, `network`. |
| `request`, `requests`, `responses` | The decoded messages. |
| `protocol`, `page`, `context`, `frames` | How it was called, where from, and the frames it is made of. |

## Calling the real backend

```ts
import { Code } from "@connectrpc/connect";
import { statusOf } from "@heojeongbo/wirestage/connect";

import { expect, test } from "./fixtures.js";
import { EchoService } from "./gen/echo_pb.js";

test("as the page, and as someone else", async ({ browser, stage }) => {
	// As the signed-in page: the test context's cookies are sent.
	const echo = stage.connect.client(EchoService, { protocol: "grpc-web" });
	await echo.say({ text: "from the test" });

	// A second user: their context is their session.
	const second = await browser.newContext();
	const asSecond = { session: second, headers: { host: "team-b.localhost" } };
	await stage.connect.client(EchoService, asSecond).say({ text: "sign in" });

	// A refusal the test expects, without a try/catch.
	expect(await statusOf(echo.peek({ text: "secret" }))).toBe(Code.PermissionDenied);
});
```

The client shares its session context's cookie jar both ways, as Playwright's
own request context does: the cookies a response sets — an error response
included — are kept there, scoped to the site the call went to. `session:
null` sends none. Calls a client makes are recorded with `caller: "test"`.

A stage's clients are closed with the stage. Outside a stage,
`createRpcClient(service, { baseURL, protocol, headers, session })` does the
same; over gRPC it holds an HTTP/2 connection that connect-node keeps for 15
minutes once idle. That does not keep the process alive, but a server in the
same process waits for it before it finishes closing.

Errors are `ConnectError`s with the server's code; `statusOf` reads a call's
code (0 when it resolved) and rethrows anything that is not a `ConnectError`.

## Fakes for clients outside the browser

```ts
import { test } from "./fixtures.js";
import { EchoService } from "./gen/echo_pb.js";

test("a backend service reaches its fake", async ({ stage }) => {
	const server = await stage.connect.serve(
		(router) => router.service(EchoService, { say: (request) => ({ text: request.text }) }),
		{ port: 50051 }, // gRPC over HTTP/2 by default
	);
	await server.close();
});
```

Every RPC kind works here, client and bidirectional streaming included. Served
calls are recorded with `caller: "network"` and `answeredBy: "server"`. A
fixed port that is taken fails with a message naming it; the server stops with
the stage.
