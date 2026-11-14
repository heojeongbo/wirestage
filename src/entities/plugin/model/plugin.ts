import type { Clock } from "../../../shared/lib/clock/index.js";
import type {
	LogScope,
	ScopedLogger,
} from "../../../shared/lib/logger/index.js";
import type { Frame, FrameFilter, Timeline } from "../../frame/@x/plugin.js";
import type { Attachment } from "./attachment.js";
import type { HttpRouter } from "./http.js";
import type { PageHost } from "./page.js";
import type { SocketRouter } from "./socket.js";

export interface WaitForOptions {
	/** Frames to wait for. Default 1. */
	readonly count?: number;
	/** Milliseconds. Default 5000. */
	readonly timeout?: number;
	/** Milliseconds between polls of the page buffers. Default 25. */
	readonly interval?: number;
}

/**
 * Everything a plugin may use. A plugin never drives the browser itself:
 * routing and page hooks go through these services, built and owned by the
 * stage, and that is the seam that lets each plugin be unit-tested against
 * fakes and lets several plugins share one browser context without stepping
 * on each other.
 */
export interface PluginContext {
	/**
	 * The name the plugin is set up under: its own, or the one `named()` gave
	 * it. A plugin records its frames with this as their `protocol` (and
	 * names its page modules by it), so two instances keep their traffic
	 * apart.
	 */
	readonly name: string;
	readonly timeline: Timeline;
	readonly clock: Clock;
	/** Scoped to the plugin's declared scope. */
	readonly log: ScopedLogger;
	/** HTTP: fetch, XHR, EventSource, and anything else a route can see. */
	readonly http: HttpRouter;
	/** WebSockets. */
	readonly sockets: SocketRouter;
	/** Code that runs inside every page, for what no route can see. */
	readonly pages: PageHost;
	readonly baseURL: string | undefined;
	attachments(): readonly Attachment[];
	/** Flush every page buffer into the timeline. Call before reading frames. */
	sync(): Promise<void>;
	waitFor(filter: FrameFilter, options?: WaitForOptions): Promise<Frame[]>;
	/**
	 * Build on another plugin: set it up inside this one and get its API. A
	 * protocol layered on others (GraphQL over HTTP and WebSocket, say) is
	 * written in terms of theirs instead of re-deriving them. The stage runs
	 * the inner plugin's hooks with the outer's; it is not mounted on the
	 * stage. Wrap it in `named()` to keep its frames apart from another
	 * instance's.
	 */
	use<Api>(plugin: WirePlugin<string, Api>): Api;
}

export interface PluginRuntime<Api> {
	/** Mounted on the stage under the plugin's name. */
	readonly api: Api;
	/** A context was attached. Page modules and HTTP rules are already in place. */
	attach?(attachment: Attachment): void | Promise<void>;
	/** A context is being detached. */
	detach?(attachment: Attachment): void | Promise<void>;
	/** The stage is being disposed; release servers and timers. */
	dispose?(): void | Promise<void>;
}

/**
 * A protocol, as the stage sees it. The stage knows nothing about any
 * protocol in particular: REST, Connect, WebRTC and the rest are all plugins,
 * and a new protocol is a new plugin, not a change to the stage.
 */
export interface WirePlugin<Name extends string = string, Api = unknown> {
	/** The key its API is mounted under: `stage.<name>`. */
	readonly name: Name;
	/** The badge on the plugin's log lines; eight characters fit the column. */
	readonly scope?: LogScope;
	setup(context: PluginContext): PluginRuntime<Api>;
}

export type AnyWirePlugin = WirePlugin<string, unknown>;

/** `{ webrtc: WebRtcApi, connect: ConnectApi }` from `[webrtc(), connect()]`. */
export type PluginApis<Plugins extends readonly AnyWirePlugin[]> = {
	readonly [Plugin in Plugins[number] as Plugin["name"]]: Plugin extends WirePlugin<
		string,
		infer Api
	>
		? Api
		: never;
};
