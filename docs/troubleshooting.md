# Troubleshooting

## A live stream never reaches the page

Server streams and SSE are answered from a local server on 127.0.0.1: the
page's request is redirected there with `route.continue({ url })`.

- **Chromium's Local Network Access** blocks a page whose address space it
  cannot place — any page a route fulfilled, any remote origin — from reaching
  loopback. wirestage grants `local-network-access` to a context the first
  time it opens a live stream there; the grant stays for the life of the
  context. A page served by a real dev server on localhost needs nothing. If
  you launch Chromium yourself with a policy that refuses the grant, add
  `--disable-features=LocalNetworkAccessChecks`.
- **https pages** need a stream server with TLS, because Playwright only
  redirects within the same scheme: `createStage({ streamServer: { tls: { key, cert } } })`.
  Without it the stub answers 500 with a message saying so; or use
  `connect({ streaming: "buffered" })` for streams that end.
- **The page awaits `fetch()` before the test sends.** A Connect server sends
  the response headers with the first message, so `fetch()` resolves only
  after the first `send`. Send first, or do not block the test on the page.

## "page module registered after the stage was attached"

Init scripts are fixed when a context is attached. Create the stage with every
plugin before calling `attach`.

## Page hooks record nothing

- The page was opened before `attach`: init scripts run only in documents
  created afterwards. Attach, then `goto`.
- A read went on without a frame that did not answer within `pageTimeoutMs`
  (2 s) — a page stuck on a dialog, say. A warning says so; what that frame
  had buffered arrives with the next read that reaches it.

## A WebSocket mock is ignored

`websocket({ lazy: true })` installs the route with the first `mock()` or
`proxy()`, and it reaches only documents loaded after that. Add the mock
before `goto`, or drop `lazy` ([websocket.md](protocols/websocket.md)).

## A request is answered by the wrong rule

The newest rule wins. A suite-wide stub added in a fixture is overridden by a
test's own; `times` and `match` decide when a rule steps aside. `WIRESTAGE_LOG=debug`
shows which rule handled what.

## The page gets a 500 it did not expect

A rule threw. The body names it — `wirestage: rule "GET /rooms/:id" failed:
…` — the error is logged, and the timeline has a `fault` frame with
`meta.reason: "rule-error"`.

## A response is missing from `calls()`

A response from the real backend is recorded once the browser has received
all of it. Right after the page's `fetch()` resolved, only the headers have
arrived: `await stage.waitFor({ kind: "response" })`. A request the browser
redirected is recorded with the redirect's status.

## An EventSource does not reconnect after `cut()`

That is Chromium: a reset on a request Playwright redirected is fatal to an
EventSource. Use `end()` to test reconnects ([sse.md](protocols/sse.md)).

## `require()` of the package fails

The package is ES modules, which `require()` loads from Node 22.12. In
TypeScript, set `moduleResolution` to `node16`, `nodenext` or `bundler`: the
older `node` resolution does not read `exports`, and cannot find the
subpaths.
