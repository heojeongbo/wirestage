# wirestage

Record, fake and fault-inject browser wire traffic in Playwright. One package,
one subpath per protocol. Full docs in [`docs/`](docs/); this file is the short
version — the rules that are non-obvious, and why each exists.

## Layout

```
src/index.ts, src/<protocol>.ts   entrypoints: re-export public APIs only
src/app/playwright                the @playwright/test fixture (composition root)
src/widgets/stage                 the stage: engines + plugin mounting
src/features/<protocol>           one plugin per protocol
src/entities/frame                Frame, Payload, Timeline (the domain)
src/entities/plugin               the plugin contract (SPI)
src/shared/api                    Playwright ports, local servers (infrastructure)
src/shared/lib                    pure utilities
src/__fixtures__                  test fakes and generated test protos (not shipped)
tests/unit, tests/types, tests/browser, e2e/, bench/, scripts/
```

## Commands

```sh
pnpm check           # lint, boundaries, types, 100% coverage, build, docs, package
pnpm check:browser   # real Chromium: browser tests, e2e against the build, perf budgets
pnpm test            # unit only, fast
pnpm bench           # micro-benchmarks
pnpm gen:proto       # regenerate src/__fixtures__/gen from tests/proto
```

Run them in the devcontainer (`devcontainer up --workspace-folder .`): it is
the Playwright image for the pinned version, with node_modules in a volume so
a host install never collides with the container's. The host needs its own
`pnpm install` for editor types and the git hooks.

## Non-obvious rules

**Architecture is enforced, not reviewed.** `pnpm fsd:check`
(`scripts/boundaries.ts`, tested in `tests/unit/boundaries.test.ts`) fails on
an upward import, a cross-slice import (except `entities/<a>/@x/<b>.ts`), a
deep import past a unit's `index.ts`, `model` importing `lib`, anything but an
entrypoint importing a feature, Playwright anywhere but `app/playwright` (and
there only as `import type`), Connect or protobuf outside `features/connect`,
log-palette outside `shared/lib/logger`, Node built-ins outside
`shared/api` and `features/connect`, a unit re-exporting another unit, an
entrypoint holding anything but `export … from`, and a file under `src` that
is not TypeScript. It reads every file and walks the whole syntax tree:
dynamic imports, `require`, `import("…")` types and `getBuiltinModule` count.
See [docs/architecture.md](docs/architecture.md). A new rule gets a test case.

**Plugins never see Playwright or the browser context.** They get a
`PluginContext` and return decisions (`HttpOutcome`) or handle a `SocketView`.
Anything a plugin needs from the browser becomes a service on the context,
with its contract in `entities/plugin` and its engine in `widgets/stage`. The
contract names neither Playwright nor Node.

**One engine owns each browser hook.** One HTTP route, one WebSocket route,
one init script and one binding per attached context. The HTTP router runs
the rule chain itself, so one request is one `HttpRequestView`, one
`correlation`, and one recording however many rules see it.

**A frame's `source` is who produced it** — `page`, `network`, `stub`,
`server`, `test` — in every plugin. A stub's answer is never `network`. Fault
frames carry `meta.reason`, lifecycle frames `meta.event`.

**Code that runs in the page is serialized with `toString()`.** Installers and
`page.evaluate` functions must be self-contained, declared with `function`
(an object-method body is not a valid expression), and are tested both called
directly (coverage) and rebuilt from their source (self-containment).
`buildPageScript` defines `__name` because tsx's `keepNames` injects it; e2e
runs the tsc build, where it is absent. `pages.register()` refuses an
installer the page could not rebuild. Page code reaches every frame, sends
what it holds on `beforeunload` and `pagehide`, and undoes itself in
`onDetach` — or when its binding is removed under it, so it never throws into
the app.

**The fakes model the browser, and the browser tests check the fakes.** When
`tests/browser` disagrees with `src/__fixtures__`, the fake is wrong: fix it
first. Some that were learned this way: a WebSocket close is reported to its
own `onClose` handler again; an end with no `onMessage` handler passes its
messages on to the other end; a binding call from the `pagehide` of a frame
that is navigating never arrives, and a removed binding throws synchronously;
and the server's end of a WebSocket is closed by the browser's
`WebSocket.close()`, which throws on a code outside 1000/3000-4999, on a reason
without a code and on a reason over 123 bytes.

**Coverage is 100% per file, and stays that way.** Unreachable defensive code
is removed or restructured, never covered with contortions. A branch only a
browser reaches means the logic belongs behind a port.

**Time goes through `Clock`.** No `setTimeout` in logic; tests use
`createManualClock()`.

**Live streams redirect to a local server.** `route.fulfill` cannot stream.
The redirect needs `local-network-access` in Chromium (granted lazily by the
router), the same scheme as the page (TLS for https), and the stream server
answers CORS and Private Network Access preflights. Streams are spread over
several ports: a browser opens six connections to one.

**Match real servers, even when it is inconvenient.** Stubs run connect-es's
own handlers: headers arrive with the first message, errors are encoded the
way Connect encodes them. A test tool that is more convenient than the server
hides the bugs the test was written for.

**Errors are contained and named.** An HTTP rule that throws answers 500 with
its label, a socket rule closes the page's socket with 1011, and both record a
`rule-error` fault; attach rolls back; detach and dispose run every step and
throw what failed at the end. Nothing rejects into Playwright, where it would surface in
whichever test runs next.

**No `console`, no `any`.** Log through `createScopedLogger(scope)`; the
loggers are the library's own and never touch log-palette's process-wide
registry. The one `any` is in `shared/api/playwright/ports.ts` with the reason
beside it.

**Docs are compiled.** Every `ts` block in the README and `docs/` is
type-checked against the build (`pnpm docs:check`). `// not checked` needs a
reason next to it.

**A non-obvious choice carries a comment naming the failure it prevents.**

## Before you commit

`pnpm check`, and `pnpm check:browser` when page code, routing or streaming
changed. Conventional Commits; the body says why.
