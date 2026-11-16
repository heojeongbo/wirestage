import type { Frame } from "../../../entities/frame/index.js";
import type {
	AbortErrorCode,
	HttpRequestView,
	StreamEnd,
} from "../../../entities/plugin/index.js";
import type { UrlMatcher } from "../../../shared/lib/match/index.js";

export type RestMethod =
	| "GET"
	| "POST"
	| "PUT"
	| "PATCH"
	| "DELETE"
	| "HEAD"
	| "OPTIONS";

export interface RestOptions {
	/** A path prefix (`/api/v1`) or an origin (`https://api.example.test`) routes are relative to. */
	readonly baseURL?: string;
	/**
	 * Record requests that no route answers, with their real responses.
	 * `true` records everything under `baseURL`. A request a route does
	 * answer is recorded by that route, not twice.
	 */
	readonly record?: boolean | UrlMatcher;
}

/**
 * A request a route is deciding about. For a request a served fake received
 * (`serve()`), `page` is undefined, `context` is empty and `resourceType` is
 * `other`.
 */
export interface RestRequest extends HttpRequestView {
	/** `:name` segments of the matched path. */
	readonly params: Readonly<Record<string, string>>;
	readonly query: URLSearchParams;
}

/**
 * A response a `stream()` reply holds open, written at the test's pace. The
 * same on a page's route and a served fake's.
 */
export interface RestStream {
	/**
	 * Write a chunk. Resolves once it is written, and on the timeline as a
	 * `message`; rejects with `CLOSED` once the response is over, the client
	 * letting go included.
	 */
	write(chunk: Uint8Array | string): Promise<void>;
	/** End the response cleanly. Resolves once the end is on the timeline. */
	end(): Promise<void>;
	/**
	 * Reset the connection mid-response, as a network drop would. Resolves
	 * once the cut is on the timeline.
	 */
	cut(): Promise<void>;
	/**
	 * Resolves when the response is over, with how, once that is on the
	 * timeline: `cancelled` when the client let go of it, or its server
	 * closed.
	 */
	readonly closed: Promise<StreamEnd>;
}

/**
 * What a resolver answers. Build one with the helpers: `json`, `text`,
 * `stream`, `abort`, ...
 */
export type RestReply =
	| {
			readonly kind: "response";
			readonly status: number;
			readonly headers: Readonly<Record<string, string>>;
			readonly body?: Uint8Array | string;
	  }
	| {
			readonly kind: "stream";
			readonly status: number;
			readonly headers: Readonly<Record<string, string>>;
			open(stream: RestStream): void | Promise<void>;
	  }
	| { readonly kind: "passthrough" }
	| { readonly kind: "abort"; readonly error: AbortErrorCode }
	| { readonly kind: "delay"; readonly ms: number; readonly reply: RestReply };

export type RestResolver =
	| RestReply
	| ((request: RestRequest) => RestReply | Promise<RestReply>);

export interface RestRouteOptions {
	readonly times?: number;
	readonly match?: (request: RestRequest) => boolean;
}

export interface RestRoute {
	/** Requests this route answered. */
	readonly hits: number;
	readonly requests: readonly RestRequest[];
	/** The next request this route answers (or answered and nobody took). */
	next(options?: { readonly timeout?: number }): Promise<RestRequest>;
	remove(): Promise<void>;
}

export interface RestCall {
	readonly correlation: string;
	readonly method: string;
	readonly url: string;
	readonly request: Frame;
	readonly response: Frame | undefined;
	/**
	 * The HTTP status; undefined for an aborted or unfinished request. A
	 * stream's is its head's, there while the stream is still open.
	 */
	readonly status: number | undefined;
	/** The served fake that received it (its URL); undefined for a page's. */
	readonly server: string | undefined;
}

export interface RestServeOptions {
	/**
	 * 0, the default, picks a free port. A fixed port that is taken fails,
	 * naming the server — unless one of this stage's WebSocket servers
	 * listens there (`websocket.serve()`): the two then share it, plain
	 * requests coming here and WebSocket handshakes going there.
	 */
	readonly port?: number;
	/** Default 127.0.0.1. */
	readonly host?: string;
	/** Names the server in errors, 404s and logs. Default `<plugin> server`. */
	readonly name?: string;
	/** A path prefix the server's routes are relative to. */
	readonly baseURL?: string;
}

/**
 * A fake HTTP backend for clients outside the browser — a service under
 * test, an agent — routed and recorded like the page's own requests. A route
 * that passes a request through hands it to the next older route; with none
 * left, the server answers 404.
 */
export interface RestServer
	extends Pick<RestApi, "on" | "get" | "post" | "put" | "patch" | "delete"> {
	readonly url: string;
	readonly port: number;
	/** This server's calls, oldest first. */
	calls(filter?: {
		readonly method?: string;
		readonly path?: RestPath;
	}): Promise<RestCall[]>;
	/** Stop accepting and drop open connections. The stage closes it too. */
	close(): Promise<void>;
}

export type RestPath = string | RegExp;

export interface RestApi {
	on(
		method: RestMethod | "*",
		path: RestPath,
		resolver: RestResolver,
		options?: RestRouteOptions,
	): Promise<RestRoute>;
	get(
		path: RestPath,
		resolver: RestResolver,
		options?: RestRouteOptions,
	): Promise<RestRoute>;
	post(
		path: RestPath,
		resolver: RestResolver,
		options?: RestRouteOptions,
	): Promise<RestRoute>;
	put(
		path: RestPath,
		resolver: RestResolver,
		options?: RestRouteOptions,
	): Promise<RestRoute>;
	patch(
		path: RestPath,
		resolver: RestResolver,
		options?: RestRouteOptions,
	): Promise<RestRoute>;
	delete(
		path: RestPath,
		resolver: RestResolver,
		options?: RestRouteOptions,
	): Promise<RestRoute>;
	/** Recorded REST exchanges, oldest first: the pages' and served fakes'. */
	calls(filter?: {
		readonly method?: string;
		readonly path?: RestPath;
	}): Promise<RestCall[]>;
	/** Serve routes on a port of their own, for clients outside the browser. */
	serve(options?: RestServeOptions): Promise<RestServer>;
}
