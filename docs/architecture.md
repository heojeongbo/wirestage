# Architecture

wirestage is laid out in Feature-Sliced Design layers, and the layers are the
rings of a clean architecture: dependencies point inward, toward the domain,
and the outside world — Playwright, Connect, Node's servers — is reached only
through ports. The rules below are enforced by `pnpm fsd:check`
(`scripts/boundaries.ts`), not by review, and the checker is itself tested
(`tests/unit/boundaries.test.ts`): one case per rule.

```
src/
  index.ts  playwright.ts  connect.ts  rest.ts  sse.ts  websocket.ts  webrtc.ts
  │   package entrypoints: re-export public APIs, nothing else
  │
  app/playwright        composition root for @playwright/test: the fixture
  widgets/stage         the stage: builds the engines, mounts the plugins
  features/<protocol>   connect, rest, sse, websocket, webrtc: one plugin each
  entities/frame        the domain: Frame, Payload, Timeline, filters
  entities/plugin       the plugin contract (SPI): rules, sockets, page modules
  shared/api            infrastructure: Playwright ports, local servers
  shared/lib            pure utilities: bytes, envelopes, matching, async, clock, logger
```

A slice holds `index.ts` (its public API), `model/` (its types) and `lib/`
(its code). A shared module is a folder with an `index.ts`.

## The rules

```
        app ──► widgets ──► entities ──► shared
                   │            ▲
                   │            │ written against the contract
                   │        features
                   └── implements the contract (the engines)

        entrypoints ──► one unit each: the core, the fixture, one feature
```

Where files may be:

- **S1.** A source file is a package entrypoint (`src/<name>.ts`) or sits in a
  unit: a slice `<layer>/<slice>/…` or a shared module
  `shared/<api|lib>/<module>/…`.
- **S2.** A unit has one `index.ts`, at its root.
- **S3.** A slice holds `index.ts` and FSD segments (`api`, `config`, `lib`,
  `model`, `ui`); an entity may also hold `@x`.

What may import what:

1. A layer imports only layers below it:
   app → widgets → features → entities → shared.
2. Slices of one layer do not import each other. The one exception is FSD's
   cross-import notation between entities: `entities/plugin` imports
   `entities/frame/@x/plugin.ts`, a file that exists to make that single
   dependency explicit, and nobody else may import it.
3. Anything outside a unit goes through its `index.ts`; anything inside goes
   around it.
4. In a slice, `model` does not import `lib`: types do not depend on code.
5. **The core knows no protocol.** Only a package entrypoint imports a
   feature — not the stage, not the fixture.
6. `shared/lib` is pure: it does not import `shared/api`.
7. An entrypoint re-exports public APIs and nothing else: `index.ts` what lies
   below the features, `playwright.ts` the fixture, `<name>.ts` the feature of
   that name. Importing the core therefore never loads a protocol's peers.

Third-party code has its own rules, because that is where a clean
architecture usually leaks:

8. **Playwright is named only by `app/playwright`, and only as types.** The
   library drives the `BrowserContext` the caller hands it through structural
   ports (`shared/api/playwright/ports.ts`); real objects satisfy them as they
   are (`tests/types/playwright-ports.ts` proves it), and the unit suite
   substitutes fakes. `import { type X }` does not count as a type import: it
   still loads the module.
9. **Connect and protobuf stay in `features/connect`**, so the other entries
   work with those peers absent (`pnpm package:check` installs the packed
   tarball without them).
10. **log-palette stays in `shared/lib/logger`.**
11. **Node built-ins** belong to `shared/api` and `features/connect` (zlib,
    http, http2). A widget may name their types — the stage adapts Node's
    response to the contract's `ResponseStream`. Nothing else names them: the
    plugin contract is written without Node.
12. There is no other dependency.
13. **A plugin is never handed the browser context.** Below the stage, the
    only Playwright ports are `PagePort` and `CookieJarPort`, as types.
14. A module specifier is a string literal, and there is no `require`.

Tests and `src/__fixtures__` are not shipped and not held to these rules, but
shipped code may not import them.

## The engines

The stage builds four engines and hands plugins their contracts. Each owns one
thing in the browser, so two plugins never install competing hooks.

| Engine (`widgets/stage/lib`) | Contract (`entities/plugin`) | Owns |
| --- | --- | --- |
| `http-router.ts` | `HttpRouter`, `HttpRule`, `HttpOutcome` | One Playwright route per attached context. |
| `socket-router.ts` | `SocketRouter`, `SocketRule`, `SocketView` | One WebSocket route per attached context. |
| `page-host.ts`, `page-runtime.ts` | `PageHost`, `PageModule` | One init script and one binding per attached context. |
| `response-stream.ts` over `shared/api/stream-server` | `ResponseStream` | Local servers for responses that stay open. |

`reads.ts` is the stage's read side (`frames`, `drain`, `mark`, `since`,
`between`, `waitFor`, `report`), and `create-stage.ts` is the composition
root: the only place engines are constructed and plugins mounted.

## How a request flows

```
page fetch ──► the context's one Playwright route
                 │  HTTP router: runs the rule chain itself, newest first
                 │    method, url, match → claim `times` → record the request once
                 ▼
               rule.handle(view)  ◄── plugin (features/*), a pure decision
                 │
     fulfill ◄───┼───► stream: redirect to a local stream server, which
     abort       │             writes at the test's pace (server streams, SSE)
     fallback ───┴───► next rule … or continue to the network; the response
                       is recorded when the browser has received all of it
```

A plugin never touches a `Route`. It returns an `HttpOutcome` — a closed union
— and the router carries it out through a table keyed by the outcome's type,
so a new outcome does not compile until the router handles it. That is what
lets every plugin be tested against fakes, and what lets the router guarantee
one recording per request, `times` claimed before the rule runs, and a 500
(not a hang) when a rule throws.

One route per context, installed with the first rule, because the chain is
the router's: every rule a request reaches shares one `HttpRequestView` and
one `correlation`, which Playwright's own route chain cannot give.

WebSockets take the same shape: one route per context whose predicate asks
the live rule list, installed with the first rule or — when a plugin asked
with `prepare()` — at attach.

Page-side code too. Plugins register `PageModule`s; the page host injects all
of them as one init script per context, with one binding back to Node. Each
frame of each page batches what its modules emit — the first entry after a
quiet spell is sent at once — and a read flushes every frame first, bounded
by a timeout so a stuck page cannot stall the test. Detaching runs every
module's `onDetach` and removes the hooks.

## Lifecycle

`attach` installs page hooks, then routes, then runs the plugins' `attach`
hooks; a failure at any step undoes the ones before it. `detach` and `dispose`
run every step even when one throws, and report what failed at the end.
Closing a context detaches it.

## Where new code goes

| New thing | Layer |
| --- | --- |
| A protocol | `features/<name>`: a `WirePlugin` built only from `PluginContext`, plus `src/<name>.ts` |
| A capability every plugin needs (a new outcome, a new service) | the contract in `entities/plugin`, the engine in `widgets/stage` |
| A codec, a parser, a data structure | `shared/lib/<module>` |
| A way to reach the outside world | a port in `shared/api` |
| A runner integration (another test framework) | `app/<runner>`, plus `src/<runner>.ts` |
