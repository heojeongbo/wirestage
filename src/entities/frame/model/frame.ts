/**
 * Which way a frame travelled, from the page's point of view: `out` left the
 * page (a request, a sent message), `in` reached it. Markers and lifecycle
 * events travel nowhere.
 */
export type Direction = "out" | "in" | "none";

export type FrameKind =
	/** The opening half of an exchange: an HTTP request, an RPC's request message. */
	| "request"
	/** The closing half: an HTTP response, an RPC's status. */
	| "response"
	/** One message on a stream or channel. */
	| "message"
	/** One server-sent event. */
	| "event"
	/** A named point the test placed on the timeline. */
	| "marker"
	/** Something went wrong on purpose or by accident: an abort, a drop, a cut. */
	| "fault"
	/** A channel or connection opened or closed. */
	| "lifecycle";

/**
 * Who produced what the frame carries. With `direction` it says who was
 * talking to whom: `out` from `page` is the app speaking, `in` from `stub`
 * is a stub answering it, `in` from `network` the real backend.
 */
export type FrameSource =
	/** The app in the browser: its requests, the messages it sends. */
	| "page"
	/** The real backend, a real remote peer, or a client outside the browser. */
	| "network"
	/** A stub: its responses, its messages, the faults it injects. */
	| "stub"
	/** The test itself: markers, drive-client requests, injected messages. */
	| "test"
	/** A fake served on a port of its own (`serve()`). */
	| "server";

/**
 * A payload as given: bytes, text, or a thunk that encodes on demand. The thunk
 * keeps a high-rate stub from serializing every message twice when nobody ever
 * reads the bytes back.
 */
export type PayloadInput = Uint8Array | string | (() => Uint8Array);

export interface Payload {
	/** True when the frame carries no payload at all. */
	readonly empty: boolean;
	bytes(): Uint8Array;
	/** UTF-8 text of the bytes, or the text as given. */
	text(): string;
	/** `JSON.parse(text())`. Throws on invalid JSON. */
	json<T = unknown>(): T;
	/**
	 * Decode with `decoder`, cached per decoder: asserting on the same frame
	 * from three helpers decodes it once.
	 */
	decode<T>(decoder: (bytes: Uint8Array) => T): T;
}

export interface FrameInit {
	/** The protocol plugin's name: `webrtc`, `connect`, `rest`, ... */
	readonly protocol: string;
	readonly kind: FrameKind;
	readonly direction: Direction;
	/**
	 * What the frame is about, in the protocol's own terms: a URL path, an RPC
	 * (`pkg.Service/Method`), a channel label, a WebSocket URL, a marker name.
	 */
	readonly endpoint: string;
	readonly source: FrameSource;
	/** Epoch milliseconds. Defaults to the stage clock's now. */
	readonly at?: number;
	readonly data?: PayloadInput;
	/** An already-decoded form of the payload, e.g. a protobuf message. */
	readonly value?: unknown;
	readonly meta?: Readonly<Record<string, unknown>>;
	/** The page the frame belongs to (`p1`, ...). */
	readonly page?: string;
	/** The browser context the frame belongs to (`c1`, ...). */
	readonly context?: string;
	/** Links the frames of one exchange: a request, its messages, its response. */
	readonly correlation?: string;
}

export interface Frame {
	/** Arrival order on the timeline, starting at 1. The order to trust. */
	readonly seq: number;
	/** Epoch milliseconds. Informational: page and Node clocks differ slightly. */
	readonly at: number;
	readonly protocol: string;
	readonly kind: FrameKind;
	readonly direction: Direction;
	readonly endpoint: string;
	readonly source: FrameSource;
	readonly payload: Payload;
	readonly value: unknown;
	readonly meta: Readonly<Record<string, unknown>>;
	readonly page: string | undefined;
	readonly context: string | undefined;
	readonly correlation: string | undefined;
}

export interface FrameFilter {
	readonly protocol?: string | readonly string[];
	readonly kind?: FrameKind | readonly FrameKind[];
	readonly direction?: Direction;
	/** Exact match, or a RegExp tested against the endpoint. */
	readonly endpoint?: string | RegExp;
	readonly source?: FrameSource;
	readonly page?: string;
	readonly context?: string;
	readonly correlation?: string;
	/** Only frames whose `seq` is greater. */
	readonly after?: number;
	/** Any further condition. Runs last, so cheap fields filter first. */
	readonly where?: (frame: Frame) => boolean;
}

/** A consumer's position on the timeline: each `take` returns what is new. */
export interface TimelineCursor {
	/**
	 * Frames appended since the previous `take` that match `filter`. The
	 * cursor moves past ALL of them, matching or not: "what happened since I
	 * last looked", narrowed.
	 */
	take(filter?: FrameFilter): Frame[];
	/** The `seq` the cursor has read up to. */
	readonly position: number;
}

export interface SnapshotFrame {
	readonly seq: number;
	readonly at: number;
	readonly protocol: string;
	readonly kind: FrameKind;
	readonly direction: Direction;
	readonly endpoint: string;
	readonly source: FrameSource;
	readonly page?: string;
	readonly context?: string;
	readonly correlation?: string;
	readonly meta?: Readonly<Record<string, unknown>>;
	/** Base64 of the payload, cut at the snapshot's byte limit. */
	readonly data?: string;
	readonly size?: number;
	readonly truncated?: boolean;
}

/** A JSON-safe copy of the timeline, for a test report attachment. */
export interface TimelineSnapshot {
	readonly frames: readonly SnapshotFrame[];
	/** Frames dropped from the front because the timeline hit its capacity. */
	readonly evicted: number;
	/** Earlier matching frames left out by the snapshot's `limit`. */
	readonly omitted: number;
}

export interface SnapshotOptions {
	/** Bytes of payload kept per frame. Default 4096. */
	readonly maxBytes?: number;
	/** Frames kept, counting back from the newest. Default: all of them. */
	readonly limit?: number;
}

export interface Timeline {
	/** Append a frame and notify subscribers. The only way frames enter. */
	append(init: FrameInit): Frame;
	frames(filter?: FrameFilter): Frame[];
	last(filter?: FrameFilter): Frame | undefined;
	/** The most recent marker with this name. */
	marker(name: string): Frame | undefined;
	/**
	 * Called for every appended frame, synchronously, after it is on the
	 * timeline. A listener that throws does not stop the others. Returns
	 * unsubscribe.
	 */
	subscribe(listener: (frame: Frame) => void): () => void;
	/** A new cursor starting at the current end. */
	cursor(): TimelineCursor;
	/** Drop every frame. `seq` keeps counting; `evicted` is left alone. */
	clear(): void;
	snapshot(filter?: FrameFilter, options?: SnapshotOptions): TimelineSnapshot;
	/** A human-readable listing, one line per frame. */
	format(filter?: FrameFilter, options?: { readonly limit?: number }): string;
	readonly size: number;
	readonly evicted: number;
	readonly capacity: number;
}
