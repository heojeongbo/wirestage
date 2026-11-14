import type { Frame } from "../../../entities/frame/index.js";
import type {
	HttpRequestView,
	StreamEnd,
} from "../../../entities/plugin/index.js";
import type { UrlMatcher } from "../../../shared/lib/match/index.js";

/** One server-sent event. A non-string `data` is sent as JSON. */
export interface SseEvent {
	readonly data?: unknown;
	readonly event?: string;
	readonly id?: string;
	/** Reconnection delay the client should use, in milliseconds. */
	readonly retry?: number;
	/** A `:` comment line, e.g. a keep-alive. */
	readonly comment?: string;
}

/** How a connection ended. `cancelled` means the page closed it. */
export type SseEnd = StreamEnd;

export interface SseConnection {
	readonly request: HttpRequestView;
	/**
	 * The `Last-Event-ID` the client reconnected with. Read off the request the
	 * stream server received: the browser's network stack adds it after
	 * Playwright's route has seen the request, so `request.headers` lacks it.
	 */
	readonly lastEventId: string | undefined;
	/** Events written so far. */
	readonly sent: number;
	/** Write an event. A string is sent as `data`. Resolves once written. */
	send(event: SseEvent | string): Promise<void>;
	/** Close cleanly; EventSource will reconnect after its retry delay. */
	end(): Promise<void>;
	/** Reset the connection, as a network drop would. */
	cut(): Promise<void>;
	readonly closed: Promise<SseEnd>;
}

export interface SseStreamOptions {
	readonly times?: number;
	readonly status?: number;
	readonly headers?: Readonly<Record<string, string>>;
	/** Sent before anything else: the client's reconnection delay. */
	readonly retry?: number;
	readonly match?: (request: HttpRequestView) => boolean;
}

export interface SseStub {
	/** Requests this stub answered. */
	readonly hits: number;
	/** The next connection the page opens (or opened and nobody took). */
	next(options?: { readonly timeout?: number }): Promise<SseConnection>;
	readonly connections: readonly SseConnection[];
	/** Send to every open connection. */
	broadcast(event: SseEvent | string): Promise<void>;
	remove(): Promise<void>;
}

export interface SseApi {
	/** Answer matching requests with an event stream the test drives. */
	stream(url: UrlMatcher, options?: SseStreamOptions): Promise<SseStub>;
	/** Events sent so far, oldest first. */
	events(filter?: { readonly endpoint?: string | RegExp }): Promise<Frame[]>;
}
