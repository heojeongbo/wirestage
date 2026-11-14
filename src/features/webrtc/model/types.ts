import type { Frame, FrameFilter } from "../../../entities/frame/index.js";
import type { PagePort } from "../../../shared/api/playwright/index.js";

export interface WebRtcOptions {
	/**
	 * Data channel labels to record. Every channel when omitted. Recording a
	 * 60 Hz channel nobody asserts on costs a base64 copy per frame.
	 */
	readonly labels?: readonly string[];
	/** Directions to record. Both by default. */
	readonly record?: readonly ("in" | "out")[];
	/** Record channel open/close as lifecycle frames. Default true. */
	readonly lifecycle?: boolean;
}

export type RtcDirection = "in" | "out" | "both";

export interface WebRtcApi {
	/** Every WebRTC frame (messages, lifecycle, faults), narrowed by `filter`. */
	frames(filter?: Omit<FrameFilter, "protocol">): Promise<Frame[]>;
	/** Messages on one channel, oldest first. */
	messages(
		label: string,
		options?: { readonly direction?: "in" | "out" },
	): Promise<Frame[]>;
	/**
	 * Drop messages on `label` while the channel stays open — the lossy-link
	 * case no server-side knob can produce, because the server is behaving.
	 * `in` (the default) swallows what the peer sends the page; `out` swallows
	 * what the page sends. Injected messages still get through, so a test can
	 * silence the real peer and speak in its place.
	 *
	 * Returns a function that undoes exactly this call: the label stays
	 * suppressed for as long as another call on it is still in force.
	 */
	suppress(
		label: string,
		options?: { readonly direction?: RtcDirection },
	): Promise<() => Promise<void>>;
	/** Undo every suppression on `label`, or on every label. */
	restore(label?: string): Promise<void>;
	/**
	 * Deliver a message to the page as if the remote peer sent it, on every
	 * open channel with this label (or one page's). Returns how many channels
	 * received it.
	 */
	inject(
		label: string,
		data: Uint8Array | string,
		options?: { readonly page?: PagePort },
	): Promise<number>;
	/**
	 * Resolve with the channel's open frame. Needs `lifecycle` recording, and
	 * says so at once when it is off.
	 */
	waitForChannel(
		label: string,
		options?: { readonly timeout?: number },
	): Promise<Frame>;
}

/** The page module's fixed configuration. */
export interface RtcPageConfig {
	readonly labels: readonly string[] | null;
	readonly recordIn: boolean;
	readonly recordOut: boolean;
	readonly lifecycle: boolean;
}

/** The page module's live state, pushed to every page on change. */
export interface RtcPageState {
	readonly suppressIn: readonly string[];
	readonly blockOut: readonly string[];
}

export interface RtcInjectArgs {
	readonly label: string;
	readonly data?: string;
	readonly text?: string;
}
