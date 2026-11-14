# The timeline

Every plugin writes to one timeline. A `Frame` is one thing that crossed the
wire, or one thing the test noted about it:

| Field | Meaning |
| --- | --- |
| `seq` | The order frames reached the timeline, from 1. See [Order](#order). |
| `at` | Epoch milliseconds, by the clock of whoever recorded the frame: the page's or Node's. |
| `protocol` | The plugin's name: `rest`, `connect`, `sse`, `websocket`, `webrtc`, or the one `named()` gave it; `wirestage` for markers. |
| `kind` | `request`, `response`, `message`, `event`, `marker`, `fault`, `lifecycle`. |
| `direction` | `out` left the page, `in` reached it, `none` for markers and lifecycle. |
| `endpoint` | In the protocol's terms: a path, `pkg.Service/Method`, a channel label, a socket's path. |
| `source` | Who produced what the frame carries. See [Source](#source). |
| `payload` | `bytes()`, `text()`, `json()`, `decode(fn)` — converted lazily, cached. |
| `value` | An already-decoded form, e.g. the protobuf message of an RPC frame. |
| `meta` | Protocol details: HTTP status and headers, RPC status code, channel label. A `fault` frame always has `meta.reason`, a `lifecycle` frame `meta.event`. |
| `page`, `context` | `p1`, `c1`, ...: which page and which attached context. |
| `correlation` | Ties a request, its messages and its response together. |

## Source

With `direction`, `source` says who was talking to whom.

| `source` | Produced by |
| --- | --- |
| `page` | The app in the browser: its requests, the messages it sends. |
| `network` | The real backend, a real remote peer, or a client outside the browser calling a served fake. |
| `stub` | A stub: its responses and messages, and the faults it injects (an abort, a dropped message). |
| `server` | A fake served on a port of its own (`connect.serve()`). |
| `test` | The test itself: markers, messages it injects, calls its drive clients make. |

A request is recorded once however many rules see it, and its response
carries the source of whoever answered: a stub's answer is never `network`.

## Order

`seq` is arrival order, and for frames recorded in one place that is the order
things happened in. Frames are recorded in two places:

- **In Node**, as they happen: everything HTTP (REST, Connect, SSE) and
  WebSockets.
- **In the page**, then sent on in batches: WebRTC, and any page module of
  your own. The first entry after a quiet spell is sent at once; the rest
  follow every `pageFlushMs` (25 ms), before every read, and when the page
  navigates or closes. What a page emits once it is already going away — in
  its own `beforeunload`, `pagehide` or `unload` handlers — is lost.

So a WebRTC frame can reach the timeline up to one flush window after an HTTP
frame that happened later. When the order between the two matters, compare
`at`; within one protocol, trust `seq`.

## Reading

Every read below brings the timeline up to date first: it flushes every page's
buffer and waits for the network responses that have already come back. The
raw `stage.timeline` does not — it is for plugin code that already knows it is
current.

```ts
import type { Stage } from "@heojeongbo/wirestage";

export async function reads(stage: Stage) {
	// Everything, or a filtered view.
	await stage.frames({ protocol: "connect", kind: "response" });
	// What is new since the previous drain — any filter's drain.
	await stage.drain({ direction: "out" });
	// A named point, then what came after it, or between two of them.
	await stage.mark("before click");
	await stage.since("before click", { protocol: "webrtc" });
	await stage.mark("after click");
	await stage.between("before click", "after click");
	// Wait until frames exist, polling the pages; times out with a listing.
	await stage.waitFor({ endpoint: "room/cursor" }, { count: 3, timeout: 2_000 });
}
```

Filters combine field equality with `endpoint: RegExp`, `after: seq` and a
`where` predicate, which runs last so the cheap fields filter first.

A read is a snapshot. A response from the real backend is on the timeline once
the browser has received all of it, so a test that reads right after the page's
`fetch()` resolved — headers only — may be early: `waitFor` the response frame
instead. A real backend's stream is recorded when it ends. A read also waits
for the streams a stub is closing, so one right after `end()` or `cut()` sees
the end; and for a body the browser holds back, at most `pageTimeoutMs`.

## Reports

`stage.report()` returns `{ snapshot, text }`: a JSON-safe copy (bigints as
strings, payloads as base64 cut at 4 KiB) and a line per frame, for the
newest 1,000 frames (`report(filter, { limit })`); `snapshot.omitted` counts
the earlier ones left out. It does not flush — call `stage.sync()` first. The
Playwright fixture does both and attaches the result to a failing test.

## Capacity

The timeline keeps 100,000 frames by default (`createStage({ capacity })`) and
drops the oldest tenth when it is full. `stage.timeline.evicted` counts what
was dropped, and a snapshot reports it. A marker that was dropped is named as
such when `since` or `between` asks for it.
