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
	/** Send to every connection that is not over yet. */
	broadcast(data: WsData): void;
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

export interface WebSocketApi {
	/** Answer matching WebSockets with a fake server the test drives. */
	mock(url: UrlMatcher, options?: WsMockOptions): Promise<WsMock>;
	/** Pass matching WebSockets through to the real server, recording and optionally dropping messages. */
	proxy(url: UrlMatcher, options?: WsProxyOptions): Promise<WsProxy>;
	/** Every recorded frame: opens, messages, drops, closes. */
	frames(filter?: { readonly endpoint?: string | RegExp }): Promise<Frame[]>;
}
