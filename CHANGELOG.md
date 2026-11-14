# Changelog

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
