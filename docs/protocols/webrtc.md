# WebRTC data channels

```ts
import { test as base, expect } from "@playwright/test";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { webrtc } from "@heojeongbo/wirestage/webrtc";

const test = withStage(base, {
	plugins: [webrtc({ labels: ["room/cursor", "room/control", "room/presence"] })],
});

test("presence goes quiet, the cursor keeps flowing", async ({ page, stage }) => {
	await page.goto("/rooms/r1");
	await stage.webrtc.waitForChannel("room/presence");
	const restore = await stage.webrtc.suppress("room/presence");
	await expect(page.getByText("presence lost")).toBeVisible();
	await restore();
	const sent = await stage.webrtc.messages("room/cursor", { direction: "out" });
	expect(sent.length).toBeGreaterThan(0);
	expect(await stage.webrtc.inject("room/control", new Uint8Array([1, 2, 3]))).toBe(1);
});
```

- Every channel the page creates or receives is recorded, in every frame of
  the page, iframes included — `labels` narrows it, `record: ["out"]` keeps
  one direction, `lifecycle: false` drops the open/close frames (and with
  them `waitForChannel`, which says so).
- `suppress(label, { direction })` swallows messages while the channel stays
  open: `in` (default) what the page would receive, `out` what it sends,
  `both`. It is the lossy-link case no server can produce on purpose. The
  function it returns undoes that one call; a label stays suppressed while
  another call on it is in force. `restore(label?)` undoes them all.
- A suppression in force when a document loads reaches it just after its
  first script has run: the state comes from Node. Suppress once the channel
  is open (`waitForChannel`) rather than before `goto`.
- `inject(label, data, { page })` delivers a message as the remote peer, and
  returns how many channels got it. Injected messages pass a suppression, so
  a test can silence the real peer and speak in its place.
- A message is recorded as `out` once `send()` accepted it: a send on a
  channel that is not open throws, as it always did, and records nothing.
- Frames carry `meta.label`; suppressed ones are `fault` frames with
  `meta.reason`, injected ones have `source: "test"`. Decode payloads with
  `frame.payload.decode(fn)`. `Blob` messages are recorded without their
  bytes.

How it works: an init script wraps `RTCDataChannel.prototype.send`, wraps
`createDataChannel`, and replaces the constructor with one that listens for
`datachannel` first, so the plugin's `message` listener runs before the
page's — the only position from which `stopImmediatePropagation` can
suppress. `instanceof RTCPeerConnection`, its statics and subclasses keep
working, and detaching the stage puts the originals back — in a document that
loads during the detach too.

Chromium hides local ICE candidates behind mDNS by default; a test that opens
peers in one page needs `--disable-features=WebRtcHideLocalIpsWithMdns`.
