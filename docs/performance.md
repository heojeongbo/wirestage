# Performance

`pnpm perf` measures and writes `perf-results.json`; `pnpm perf:check` also
fails when a median exceeds its budget. `pnpm bench` runs the vitest
micro-benchmarks in `bench/` for exploring a change.

## What is measured, and the budget

| Scenario | Unit | Budget | Measured |
| --- | --- | --- | --- |
| timeline: append a 64 B frame at capacity | ns/op | 4,500 | 860 |
| timeline: query 10,000 frames | ns/op | 500,000 | 100,000 |
| envelope: decode a 100-message body | ns/op | 35,000 | 6,800 |
| connect: decode a 100-message gRPC-web response | ns/op | 40,000 | 8,000 |
| match: a glob against a full URL | ns/op | 250 | 44 |
| webrtc: send-hook overhead per 64 B send | µs/op | 12 | 2.4 |
| webrtc: flush 5,000 recorded sends | ms | 1,500 | 300 |
| connect: stubbed gRPC-web unary round trip | ms | 10 | 1.2 (p95 1.7) |
| connect: live stream, test send to page receive | ms | 5 | 0.24 (p95 0.47) |
| runtime gzip of `dist/*.js` | bytes | 81,920 | 72,024 |

Measured in the devcontainer (Node 24.15, Chromium of Playwright 1.60) on an
Apple M4 Pro host under Docker Desktop. A budget is about five times the
median measured there: room for a slower CI runner, none for a regression of
an order of magnitude. The two sub-millisecond latencies get more, because
scheduling noise is most of what they measure.

The package-size budget is not a multiple of anything: it is the ceiling
the package agreed to, raised on purpose. 0.5.0 raised it from 64 KiB to
80 KiB for the served WebSocket server — the RFC 6455 server half and the
ports the stage's fakes share, about 7 KB of gzip with their comments —
written here rather than taken as a dependency.

## Methodology

Node paths: 1,000 warm-up runs, then 9 samples, each the mean of many runs;
the table reports the median sample. Chromium paths: timings taken inside the
page with `performance.now()`, the first 10% of unary calls discarded as
warm-up. Stream latency compares the page's `performance.timeOrigin + now()`
with Node's, both epoch-based.

## What the numbers mean for a test

- A 60 Hz channel costs the page about 2 µs per frame to record.
- Recording 5,000 frames and reading them back takes a third of a second.
- A stubbed RPC adds about a millisecond; a live stream about a quarter of one.
