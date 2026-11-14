import type { UrlMatcher } from "../../../shared/lib/match/index.js";

/** One end of a routed WebSocket: the page's, or the real server's. */
export interface SocketPeer {
	/** Deliver a message to this end. */
	send(data: string | Uint8Array): void;
	/**
	 * Close this end. The page's end takes any code, as a server may close
	 * with any. The server's end is closed by the browser, which sends only
	 * 1000 and 3000-4999, and no reason without a code: anything else goes
	 * out as a normal closure, 1000, so the close still happens.
	 */
	close(options?: {
		readonly code?: number;
		readonly reason?: string;
	}): Promise<void>;
	/** Messages this end sends. One handler; a later call replaces it. */
	onMessage(handler: (data: string | Uint8Array) => void): void;
	/**
	 * This end closed, by its own doing or through `close()` — and a close
	 * the page starts is reported again once `close()` completes it, so a
	 * handler must expect to run twice. Setting one turns off the automatic
	 * forwarding of a close to the other end: the page's socket then hangs in
	 * CLOSING until the handler closes the page's end itself.
	 */
	onClose(
		handler: (code: number | undefined, reason: string | undefined) => void,
	): void;
}

/** A WebSocket a page opened, as the rule that takes it sees it. */
export interface SocketView {
	/** Links every frame of this connection. */
	readonly correlation: string;
	readonly url: URL;
	readonly context: string;
	/** The page's end. */
	readonly page: SocketPeer;
	/**
	 * Open the real server's end and return it. Nothing is forwarded for you:
	 * a rule that wants a proxy wires the two ends together itself.
	 */
	connectToServer(): SocketPeer;
}

export interface SocketRule {
	/** The `protocol` of the frames this rule records. */
	readonly protocol: string;
	/** Names the rule in logs and diagnostics. */
	readonly label: string;
	readonly url: UrlMatcher;
	/** Stop taking connections after this many. */
	readonly times?: number;
	/**
	 * Take a connection: called once per matching socket. The page's end
	 * opens only after this settles, so the rule is wired up before the
	 * first message.
	 */
	open(socket: SocketView): void | Promise<void>;
}

export interface SocketRuleHandle {
	/** Connections this rule took. */
	readonly hits: number;
	readonly active: boolean;
	/** Stop taking connections. Open ones stay as they are. */
	remove(): Promise<void>;
}

/**
 * Where plugins put WebSocket rules. Rules apply to every attached context,
 * present and future, and the newest rule that matches a socket takes it; a
 * socket no rule takes goes to the real server.
 *
 * Routing replaces `WebSocket` in every document of the context, so it
 * starts with the first rule and a stage with none leaves the page alone.
 * The replacement reaches a document as it loads: a rule added later applies
 * to the documents loaded after it, unless the plugin called `prepare()`.
 */
export interface SocketRouter {
	add(rule: SocketRule): Promise<SocketRuleHandle>;
	/**
	 * Start routing as soon as a context is attached, before any rule exists,
	 * so a rule added mid-test reaches the pages already open. Call in `setup`.
	 */
	prepare(): void;
}
