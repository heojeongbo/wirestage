import type { Frame } from "../../../entities/frame/index.js";
import type { UrlMatcher } from "../../../shared/lib/match/index.js";

export interface WebSocketOptions {
	/**
	 * Leave `WebSocket` alone until the first `mock()` or `proxy()`.
	 *
	 * By default the plugin routes WebSockets from the moment a context is
	 * attached, so a mock added mid-test reaches the pages that are already
	 * open. Playwright routes by replacing `WebSocket` in every document as it
	 * loads, and a socket no rule takes is passed through to the real server.
	 * With `lazy`, nothing is replaced until the first rule exists — and that
	 * rule then applies only to the documents loaded after it.
	 */
	readonly lazy?: boolean;
}

/** What a test may send: text, bytes in any binary form, or a value sent as JSON. */
export type WsData = string | ArrayBuffer | ArrayBufferView | object;

export interface WsMessage {
	/** `out` came from the page, `in` went to it. */
	readonly direction: "in" | "out";
	readonly data: string | Uint8Array;
	readonly at: number;
	text(): string;
	json<T = unknown>(): T;
}

export interface WsCloseInfo {
	readonly code: number | undefined;
	readonly reason: string | undefined;
}

export interface WsCloseOptions {
	/**
	 * The code the page's socket closes with: any a server may send. A proxy
	 * also closes the real server's end, through the browser, which sends
	 * only 1000 and 3000-4999 — another code reaches the page as given and
	 * the server as a normal closure, 1000.
	 */
	readonly code?: number;
	/**
	 * The page gets it whole. A proxy's real server gets at most 123 bytes
	 * of it, cut on a character: all a close frame carries, and all the
	 * browser will send.
	 */
	readonly reason?: string;
}

export interface WsConnection {
	readonly url: string;
	/** Messages the page sent, oldest first. */
	readonly messages: readonly WsMessage[];
	/** True until either side starts to close it. */
	readonly open: boolean;
	/** The next message the page sends (or sent and nobody took). */
	nextMessage(options?: { readonly timeout?: number }): Promise<WsMessage>;
	/**
	 * Send to the page. Throws `CLOSED` once the connection is over — from
	 * the moment `close()` is called — since the page would never get it.
	 */
	send(data: WsData): void;
	close(options?: WsCloseOptions): Promise<void>;
	/** Resolves when the connection is over, whoever closed it. */
	readonly closed: Promise<WsCloseInfo>;
}

export interface WsMockOptions {
	/** Answer this many connections, then leave the rest to the next rule. */
	readonly times?: number;
	/**
	 * Called for each new connection, e.g. to send a greeting. The page's
	 * socket opens once it settles. If it throws, the stage closes the
	 * page's socket with 1011 and records a `rule-error` fault.
	 */
	readonly onConnect?: (connection: WsConnection) => void | Promise<void>;
}

export interface WsMock {
	/** Connections this mock took. */
	readonly hits: number;
	readonly connections: readonly WsConnection[];
	/** The next connection the page opens (or opened and nobody took). */
	next(options?: { readonly timeout?: number }): Promise<WsConnection>;
	/** Send to every connection still open; returns how many that was. */
	broadcast(data: WsData): number;
	/** New connections go to the real server again. */
	remove(): Promise<void>;
}

export interface WsProxyOptions {
	/** Proxy this many connections, then leave the rest to the next rule. */
	readonly times?: number;
	/**
	 * Drop a message instead of forwarding it. Dropped messages are recorded
	 * as faults. If it throws, the stage closes both ends, the page's with
	 * 1011, and records a `rule-error` fault.
	 */
	readonly drop?: (message: WsMessage) => boolean;
}

export interface WsProxyConnection {
	readonly url: string;
	/** Messages in both directions, oldest first. */
	readonly messages: readonly WsMessage[];
	nextMessage(options?: { readonly timeout?: number }): Promise<WsMessage>;
	/**
	 * Inject a message to the page, as if the server sent it. Throws
	 * `CLOSED` once the connection is over, as `toServer` does.
	 */
	toPage(data: WsData): void;
	/** Inject a message to the server, as if the page sent it. */
	toServer(data: WsData): void;
	/** Close both sides. */
	close(options?: WsCloseOptions): Promise<void>;
	/** Resolves when the connection is over, whoever closed it. */
	readonly closed: Promise<WsCloseInfo>;
}

export interface WsProxy {
	/** Connections this proxy took. */
	readonly hits: number;
	readonly connections: readonly WsProxyConnection[];
	next(options?: { readonly timeout?: number }): Promise<WsProxyConnection>;
	remove(): Promise<void>;
}

export interface WsServeOptions {
	/**
	 * 0, the default, picks a free port. A fixed port that is taken fails,
	 * naming the server — unless one of this stage's REST fakes listens
	 * there (`rest.serve()`): the two then share it, as one backend answering
	 * both, WebSocket handshakes coming here and plain requests going there.
	 */
	readonly port?: number;
	/** Default 127.0.0.1. */
	readonly host?: string;
	/** Names the server in errors, refusals and logs. Default `<plugin> server`. */
	readonly name?: string;
}

/** A connection a served fake accepted: its client is outside the browser. */
export interface WsServerConnection extends WsConnection {
	/** Messages the client sent, oldest first. */
	readonly messages: readonly WsMessage[];
	/**
	 * Drop the connection with no close frame, as a dead peer or a lost
	 * network does: the client sees an abnormal closure, 1006.
	 */
	cut(): void;
}

export interface WsServerMockOptions {
	/** Take this many connections, then leave the rest to the next rule. */
	readonly times?: number;
	/**
	 * Called for each new connection, e.g. to send a greeting. If it throws,
	 * the server closes the connection with 1011 and records a `rule-error`
	 * fault.
	 */
	readonly onConnect?: (connection: WsServerConnection) => void | Promise<void>;
}

export interface WsServerMock {
	/** Connections this rule took. */
	readonly hits: number;
	readonly connections: readonly WsServerConnection[];
	/** The next connection a client opens (or opened and nobody took). */
	next(options?: { readonly timeout?: number }): Promise<WsServerConnection>;
	/** Send to every connection still open; returns how many that was. */
	broadcast(data: WsData): number;
	/** New connections go to the next rule, or are refused. */
	remove(): Promise<void>;
}

/**
 * A fake WebSocket server for clients outside the browser — a service under
 * test, an agent — recorded like the page's own sockets. The newest rule that
 * matches a handshake's URL takes it; one no rule takes is refused with 404.
 */
export interface WsServer {
	/** `ws://host:port`. */
	readonly url: string;
	readonly port: number;
	/**
	 * Accept matching connections, as `mock()` does for the page's. `url` is
	 * matched against `ws://host:port/path?query`; a glob that starts with `/`
	 * matches the path.
	 */
	mock(url: UrlMatcher, options?: WsServerMockOptions): Promise<WsServerMock>;
	/** This server's frames: handshakes, messages, closes, cuts. */
	frames(filter?: { readonly endpoint?: string | RegExp }): Promise<Frame[]>;
	/** Stop accepting and drop open connections. The stage closes it too. */
	close(): Promise<void>;
}

export interface WebSocketApi {
	/** Answer matching WebSockets with a fake server the test drives. */
	mock(url: UrlMatcher, options?: WsMockOptions): Promise<WsMock>;
	/** Pass matching WebSockets through to the real server, recording and optionally dropping messages. */
	proxy(url: UrlMatcher, options?: WsProxyOptions): Promise<WsProxy>;
	/** Every recorded frame: opens, messages, drops, closes. */
	frames(filter?: { readonly endpoint?: string | RegExp }): Promise<Frame[]>;
	/** Serve WebSockets on a port, for clients outside the browser. */
	serve(options?: WsServeOptions): Promise<WsServer>;
}
