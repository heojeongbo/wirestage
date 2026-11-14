import type {
	Frame,
	FrameFilter,
	Timeline,
	TimelineSnapshot,
} from "../../../entities/frame/index.js";
import type {
	AnyWirePlugin,
	Attachment,
	PluginApis,
	WaitForOptions,
} from "../../../entities/plugin/index.js";
import type {
	ContextPort,
	PagePort,
} from "../../../shared/api/playwright/index.js";
import type { StreamServerOptions } from "../../../shared/api/stream-server/index.js";
import type { Clock } from "../../../shared/lib/clock/index.js";

export interface StageOptions<Plugins extends readonly AnyWirePlugin[]> {
	/** The protocols this stage handles. Their APIs appear as `stage.<name>`. */
	readonly plugins: Plugins;
	/** Used by drive clients that are not given a URL of their own. */
	readonly baseURL?: string;
	/** Frames the timeline keeps. Default 100,000. */
	readonly capacity?: number;
	/**
	 * How long a page batches what it records before sending it on. Default
	 * 25 ms. The first entry after a quiet spell is sent at once.
	 */
	readonly pageFlushMs?: number;
	/**
	 * How long a page may take to answer a flush or a command, or the
	 * browser to hand over a response's body, before a read goes on without
	 * it; how long a live stream's request may take to reach the stream
	 * server before the stream is given up; and how long Playwright may take
	 * to take the page hooks out before a detach goes on. Default 2000 ms.
	 */
	readonly pageTimeoutMs?: number;
	/** TLS for live streams on https pages, and the bind host. */
	readonly streamServer?: Pick<StreamServerOptions, "tls" | "host">;
	/** Defaults for `waitFor`. */
	readonly wait?: Pick<WaitForOptions, "timeout" | "interval">;
	/** Replace time, for tests of the stage itself. */
	readonly clock?: Clock;
}

export interface AttachOptions {
	/** The context's base URL, for drive clients bound to it. */
	readonly baseURL?: string;
}

export interface StageReport {
	readonly snapshot: TimelineSnapshot;
	readonly text: string;
}

export interface MarkOptions {
	/**
	 * The page the marker is about. The marker carries its id, so a read
	 * narrowed to that page (`{ page }`) includes it.
	 */
	readonly page?: PagePort | string;
	/** Anything else worth keeping on the marker. */
	readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * A reading position of its own on the timeline: what a helper that keeps a
 * log per page, per channel or per check reads from, without moving the
 * stage's `drain` or another cursor.
 */
export interface StageCursor {
	/**
	 * Bring the timeline up to date, then take what reached it since this
	 * cursor last took — narrowed by the cursor's filter and `filter` — and
	 * move past all of it, matching or not.
	 */
	take(filter?: FrameFilter): Promise<Frame[]>;
	/** The same frames as `take`, without moving. */
	peek(filter?: FrameFilter): Promise<Frame[]>;
	/** The `seq` the cursor has read up to; 0 before its first take. */
	readonly position: number;
}

export interface ReportOptions {
	/** Frames kept, counting back from the newest. Default 1,000. */
	readonly limit?: number;
}

/** The stage itself, before plugin APIs are mounted on it. */
export interface StageCore {
	readonly id: string;
	/** The raw timeline. Reads here do NOT flush page buffers first; prefer the methods below. */
	readonly timeline: Timeline;
	readonly attachments: readonly Attachment[];
	readonly disposed: boolean;
	/**
	 * Start handling a browser context: install every plugin's routes and page
	 * hooks. Call before the first navigation. Returns a function that
	 * detaches. A failed attach is undone, so it can be tried again.
	 */
	attach(
		context: ContextPort,
		options?: AttachOptions,
	): Promise<() => Promise<void>>;
	/** Detach one context, or all of them. */
	detach(context?: ContextPort): Promise<void>;
	/** The id frames use for this page. */
	pageId(page: PagePort): string;
	/**
	 * Bring the timeline up to date: flush every page's buffer, and wait for
	 * the responses already back from the network and the ends of the
	 * streams a stub closed. The reads below do it for you.
	 */
	sync(): Promise<void>;
	frames(filter?: FrameFilter): Promise<Frame[]>;
	/** Frames since the previous `drain` (any filter), narrowed by `filter`. */
	drain(filter?: FrameFilter): Promise<Frame[]>;
	/** Put a named marker on the timeline, after everything that happened so far. */
	mark(name: string, options?: MarkOptions): Promise<Frame>;
	/**
	 * A cursor of its own, from the start of the timeline: every `take`
	 * returns what is new since the previous one.
	 */
	cursor(filter?: FrameFilter): StageCursor;
	/** Frames after the most recent marker called `marker`. */
	since(marker: string, filter?: FrameFilter): Promise<Frame[]>;
	/** Frames between two markers, exclusive. */
	between(from: string, to: string, filter?: FrameFilter): Promise<Frame[]>;
	/** Resolve with the matching frames once `count` of them exist. */
	waitFor(filter: FrameFilter, options?: WaitForOptions): Promise<Frame[]>;
	/** The newest frames as JSON and as text. Does not flush: `sync()` first. */
	report(filter?: FrameFilter, options?: ReportOptions): StageReport;
	/**
	 * Detach everything, stop servers, release plugins. Idempotent. Every
	 * step runs even when one fails; what failed is thrown at the end.
	 */
	dispose(): Promise<void>;
}

export type Stage<Plugins extends readonly AnyWirePlugin[] = readonly []> =
	StageCore & PluginApis<Plugins>;
