# Changelog

## 0.6.0 (2026-11-18)

- `connect.rewrite(method, edit)`: a call goes on to the real backend with
  the request the test changed — a poll interval, a page size, an id the page
  cannot ask for — encoded as the page encoded its own (gRPC-web or Connect,
  binary or JSON, a POST's body or a GET's query). The edit returns the
  request to send, so a misspelled field fails to compile. The call is
  recorded with the page's request as `request`, the rewrite as `forwarded`
  (source `test`), and the backend's answer.
- `connect.nextCall(method)`: the next recorded call to a method, waiting for
  one if needed, whichever rule recorded it; calls made before the first ask
  count. `settled()` waits for its answer.
- `RpcCall.requestHeaders`: the headers of a page's call, of a call a client
  made to a served fake, and of a drive client's call.
- `connect.serve(routes, { unhandled: { code, message } })` answers calls no
  route takes with that status, in the caller's protocol, through a handler
  connect-es builds for the method each call names — a fake of a service with
  no descriptors to hand.
- `@heojeongbo/wirestage/h2-proxy`: an HTTP/2 proxy for the browser under
  test (`startH2Proxy`, `h2ProxyArgs`), so a page holding more open responses
  than HTTP/1.1's six connections per origin still gets its next request
  answered; `transformHtml` edits every navigation's document.
- Fixed: a call two rules passed on — a hold released to a recorded backend —
  had the backend's answer recorded twice.

## 0.5.0 (2026-11-16)

- `websocket.serve()`: a fake WebSocket server for clients outside the
  browser — a service under test, an agent — with the page's `mock()` rules
  and recording (`source: "network"` for the client, `"server"` for the
  fake, `meta.server` its URL). A served connection can also `cut()`: no
  close frame, as a dead peer. The RFC 6455 server half is the library's own,
  with no dependency.
- One port for an API and its socket: `rest.serve()` and `websocket.serve()`
  on the same port of one stage share it, plain requests to the one and
  WebSocket handshakes to the other. A port with only a WebSocket server
  answers a plain request with 426.
- A WebSocket mock's `connection.open` says whether the connection still is,
  and `broadcast()` returns how many open connections it reached.
- `PluginContext.ports`: the stage's ports, for a plugin that serves a fake of
  its own, plain HTTP or WebSocket.
- The package-size budget is 80 KiB of gzip, up from 64 KiB, for the above.

## 0.4.0 (2026-11-14)

- `stream(open, init)`: a REST reply that stays open — a watch, a log that
  follows, a long poll — written by the test chunk by chunk, then ended or
  cut, on a page's route and a served fake's alike. Its head is the call's
  response, so `calls()` has a stream's status while it is open; each chunk
  is a `message` frame, and its end a `lifecycle` close or a `cut` fault.

## 0.3.1 (2026-11-14)

- A served fake sends `content-length` on every response with a body, HEAD
  included, as a real server does: a client that sizes a download by a HEAD
  request (an OCI registry client, say) got none. A 204 or 304 still carries
  none.

## 0.3.0 (2026-11-14)

- `rest.serve()`: a fake HTTP backend for clients outside the browser — a
  service under test, an agent — with the routes, replies and recording the
  page's requests get. Its exchanges are on the stage's timeline
  (`source: "network"` in, `"server"` out, `meta.server` its URL), and a REST
  call now says which server received it (`call.server`).

## 0.2.0 (2026-11-14)

- `stage.cursor(filter)`: a reading position of its own, for a helper that
  keeps a log per page or per channel; `take()` and `peek()` bring the timeline
  up to date first, and neither moves `drain` or another cursor.
- `stage.mark(name, { page, meta })`: a marker can carry the page it is about,
  so a read narrowed to that page includes it.
- **Breaking:** `mark`'s second argument is an options object. Write
  `mark(name, { meta })` where you wrote `mark(name, meta)`.

## 0.1.1 (2026-11-14)

Fixes from the review of 0.1.0.

- HTTP: a stream rule that throws answers the rule's 500, or cuts the
  connection once its head went out, and is recorded as a rule error instead
  of a page cancel. An answer the browser would refuse — a `continue` to
  another scheme, an unknown abort code, a header with a line break — answers
  that 500 instead of leaving the request hanging. A relative `continue` URL is
  resolved against the request; header values other than `set-cookie` are
  folded.
- Live streams: a cut before the first byte no longer turns into a 404 after a
  clean stream (every stream-server response closes its connection); a stream
  whose request never reaches the stream server is released and recorded as
  `unreached`; `write()` no longer hangs when it races the page's close; SSE's
  `end()` and `cut()` resolve once the end is on the timeline; `head()` carries
  several `set-cookie` values.
- Reads no longer wait for a response body behind a page dialog longer than
  `pageTimeoutMs`.
- `local-network-access` is granted per stream to the page's origin, and not
  at all to pages served from loopback, instead of once to the whole context
  — which denied the context's other permissions.
- WebSocket: a socket handler a rule set — a proxy's `drop` included — that
  throws fails the rule (1011, `rule-error`) instead of becoming an uncaught
  exception in the test run.

## 0.1.0 (2026-11-14)

First release.

- Core: `createStage`, one timeline for every protocol (`frames`, `drain`,
  `mark`, `since`, `between`, `waitFor`, `report`), and the plugin contract
  (`definePlugin`): HTTP rules with `fulfill`, `stream`, `continue`,
  `fallback` and `abort` outcomes, WebSocket rules, page modules, `named()`
  for two instances of one protocol and `use()` for a plugin built on
  another; manual clocks for plugin tests.
- One request is one exchange: recorded once however many rules see it, with
  the `source` of whoever answered.
- `/playwright`: `withStage` and `createStageFixture`, with the timeline
  attached to failing tests; `WIRESTAGE_LOG` and `WIRESTAGE_REPORT`;
  `attach: false` for tests that open their own contexts.
- `/connect`: Connect and gRPC-web stubs answered by connect-es's own
  handlers — unary, server streams driven from the test, whole services,
  failures, aborts, holds, cuts, each narrowed by a `match` over the decoded
  request; decoded recording of real traffic; drive clients carrying the
  page's cookies, and `statusOf` for refusals; `serve()` for clients outside
  the browser, native gRPC over HTTP/2 included.
- `/rest`: routes with `:params`, reply helpers, faults, recording.
- `/sse`: event streams driven from the test, with `Last-Event-ID` on reconnect.
- `/websocket`: fake servers and recording proxies that can drop and inject.
- `/webrtc`: data-channel recording in every frame of the page, suppression
  in either direction while the channel stays open, and injection as the
  remote peer.
- ES modules, loadable with `require()` on Node 22.12 or later.
