# Writing a protocol plugin

A plugin is a name and a `setup` that receives the stage's services and
returns an API. It never sees Playwright, the browser context, or another
plugin's internals: the built-in protocols are written against exactly this
contract, and nothing in the stage knows any of them.

```ts
import { createStage, definePlugin, type Frame } from "@heojeongbo/wirestage";

export function graphql() {
	return definePlugin({
		name: "graphql",
		setup(context) {
			return {
				api: {
					/** Answer one operation by name. */
					operation: (name: string, data: unknown) =>
						context.http.add({
							protocol: context.name,
							label: `graphql ${name}`,
							url: "/graphql",
							method: "POST",
							match: (request) =>
								request.json<{ operationName?: string }>().operationName === name,
							endpoint: () => name,
							handle: () => ({
								type: "fulfill",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ data }),
							}),
						}),
					async operations(): Promise<Frame[]> {
						await context.sync();
						return context.timeline.frames({ protocol: context.name, kind: "request" });
					},
				},
			};
		},
	});
}

const stage = createStage({ plugins: [graphql()] });
export const typed: Promise<unknown> = stage.graphql.operation("Rooms", { rooms: [] });
```

## What `setup` gets

| Service | Use |
| --- | --- |
| `name` | The name the plugin is mounted under — its own, or the one `named()` gave it. Record frames with it as their `protocol`, and name page modules by it, so two instances stay apart. |
| `timeline`, `clock` | Append frames; take time from the clock so tests can drive it. |
| `http.add(rule)` | An HTTP rule on every attached context, present and future. |
| `sockets.add(rule)` | A WebSocket rule, likewise. `sockets.prepare()` in `setup` routes sockets from attach, so a rule added mid-test reaches pages already open. |
| `pages.register(module)` | Code that runs in every frame of every page; `command`, `refresh`. |
| `sync()`, `waitFor()` | Bring the timeline up to date before reading; wait for frames. |
| `use(plugin)` | Build on another plugin and get its API. |
| `log` | A logger scoped to the plugin's `scope`. |
| `attachments()`, `baseURL` | The attached contexts: an id, a base URL and a cookie jar each. |

Return `attach`, `detach` and `dispose` hooks when the plugin holds per-context
or global resources. They get an `Attachment`, not the browser context:
anything a plugin needs from the browser is a service on the context.

## HTTP rules

A rule matches by `url`, `method`, `times` and `match`, and `handle` returns
what to do — an `HttpOutcome`, which the router carries out:

| Outcome | |
| --- | --- |
| `fulfill` | Answer with a complete response. |
| `stream` | Answer with a response that stays open; `open(stream)` writes it. |
| `continue` | Send to the network, optionally rewritten. |
| `fallback` | Let the next matching rule, or the network, decide. |
| `abort` | Fail the request at the network level. |

The router guarantees the rest, so a plugin does not have to:

- The newest rule that matches wins, and `times` is counted in requests
  handled — claimed before `handle` runs, so concurrent requests cannot share
  one turn.
- Every rule a request reaches gets the same `HttpRequestView`, with one
  `correlation`. The request is recorded once per protocol, whichever rule
  answers; a plugin that records decoded frames of its own sets
  `record: false`.
- `onPassthroughResponse` and `onPassthroughFailure` report what the network
  did with a request the rule passed on — not what another rule answered.
- A rule that throws answers 500 with its `label` and is logged; nothing is
  left hanging and nothing rejects into Playwright.

A response that stays open is a `ResponseStream`: set the head, write chunks
at the test's pace, then `end()` or `cut()`.

```ts
import { definePlugin } from "@heojeongbo/wirestage";

export const ndjson = definePlugin({
	name: "ndjson",
	setup: (context) => ({
		api: {
			/** Answer `url` with one JSON line per value, then end. */
			lines: (url: string, values: readonly unknown[]) =>
				context.http.add({
					protocol: context.name,
					label: `ndjson ${url}`,
					url,
					handle: () => ({
						type: "stream",
						async open(stream) {
							stream.head(200, { "content-type": "application/x-ndjson" });
							for (const value of values) await stream.write(`${JSON.stringify(value)}\n`);
							await stream.end();
						},
					}),
				}),
		},
	}),
});
```

`stream.requestHeaders` are the headers as the server received them, with what
the browser adds after Playwright's route saw the request (`last-event-id`);
`stream.closed` resolves with `ended`, `cut` or `cancelled`.

## WebSocket rules

`sockets.add({ protocol, label, url, times, open })`: `open(socket)` is called
for each socket the rule takes, with `socket.page` — the page's end — and
`socket.connectToServer()` for the real server's. Nothing is forwarded for
you; a proxy wires the two ends together. Each end has `send`, `close`,
`onMessage` and `onClose`. An `onClose` handler runs for every close of its
end, including the one it carries out itself, so it must be safe to run
twice; and once a handler is set, the page's socket stays in `CLOSING` until
the rule closes the page's end.

## Page modules

A page module's `install` is serialized with `toString()` and runs inside the
page, so it must be self-contained: no imports, no references to module
scope, and declared with `function`. It gets `env` with `emit`, `now`,
`encode`, `decode`, `onCommand`, `onState` and `onDetach`; Node receives
batches in `receive`.

- `state()` is what a page starts with; call `pages.refresh(id)` after
  changing it. It comes from Node, so a document's first script can run
  before it arrives.
- `pages.command(id, op, args)` runs a handler in every frame of every open
  page and returns each answer.
- Undo in `onDetach` what `install` did to the page. Detaching the stage runs
  it, so a document that outlives the stage is left as it was found.
- Register modules in `setup` — the init script is fixed at the first attach.

## Building on another plugin

`context.use(plugin)` sets another plugin up inside this one and returns its
API, so a protocol layered on others is written in terms of theirs. The inner
plugin's hooks run with the outer's; it is not mounted on the stage. Wrap it
in `named()` to keep its frames apart from another instance's.

```ts
import { createStage, definePlugin, named } from "@heojeongbo/wirestage";
import { json, rest } from "@heojeongbo/wirestage/rest";

/** A typed layer over REST for one backend. */
export const inventory = definePlugin({
	name: "inventory",
	setup(context) {
		// Under this plugin's own name, so its frames are `inventory` frames.
		const http = context.use(named(context.name, rest({ baseURL: "/inventory/v1" })));
		return {
			api: {
				stock: (sku: string, count: number) => http.get(`/stock/${sku}`, json({ sku, count })),
				calls: () => http.calls(),
			},
		};
	},
});

const stage = createStage({ plugins: [inventory] });
export const stubbed = stage.inventory.stock("bolt-m4", 12);
```

## Testing a plugin

In this repository, unit-test against the fakes in `src/__fixtures__`:
`fake-playwright.ts` reproduces route order and fallback, `continue({ url })`,
init scripts, frames and WebSocket routes, and is itself checked against real
Chromium by `tests/browser`. Use `createManualClock()` for anything with a
timeout. Keep the 100% coverage gate: a branch only a browser reaches belongs
in `tests/browser`.

The fakes are not published. A plugin that lives outside this repository
tests in a real browser, with `createStage` and a Playwright context.
