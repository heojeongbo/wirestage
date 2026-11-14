import type { UrlMatcher } from "../../../shared/lib/match/index.js";
import type { ResponseStream } from "./stream.js";

/**
 * A request a rule is deciding about, read-only and decoded on demand.
 *
 * One per request: every rule the request reaches is given this same object,
 * so a plugin may key what it knows about a request on it (a `WeakMap`), and
 * the frames different rules record for one request share one `correlation`.
 */
export interface HttpRequestView {
	/** Links every frame of this exchange. */
	readonly correlation: string;
	readonly method: string;
	readonly url: URL;
	/** Lower-cased names. */
	readonly headers: Readonly<Record<string, string>>;
	/** The page that sent it; undefined for service-worker requests. */
	readonly page: string | undefined;
	readonly context: string;
	readonly resourceType: string;
	body(): Uint8Array;
	text(): string;
	json<T = unknown>(): T;
}

/** Playwright's `route.abort` error codes. */
export type AbortErrorCode =
	| "aborted"
	| "accessdenied"
	| "addressunreachable"
	| "blockedbyclient"
	| "blockedbyresponse"
	| "connectionaborted"
	| "connectionclosed"
	| "connectionfailed"
	| "connectionrefused"
	| "connectionreset"
	| "internetdisconnected"
	| "namenotresolved"
	| "timedout"
	| "failed";

/**
 * What a rule decided. A closed union: the router carries each member out
 * through a table keyed by `type`, so a new outcome does not compile until
 * the router knows what to do with it.
 */
export type HttpOutcome =
	/**
	 * Answer with a complete response. A header may carry several values
	 * separated by a newline: `set-cookie` is sent as a header line each,
	 * any other header as one value, `, `-separated. A header Chromium
	 * would refuse — a name that is not a token, a CR or NUL in a value — is
	 * the rule's error.
	 */
	| {
			readonly type: "fulfill";
			readonly status?: number;
			readonly headers?: Readonly<Record<string, string>>;
			readonly body?: Uint8Array | string;
	  }
	/**
	 * Answer with a response that stays open (server streams, SSE): `open`
	 * gets the stream to write. The request is redirected to the stage's
	 * local stream server, which `route.fulfill` cannot stand in for because
	 * it takes the whole body at once. An `open` that throws is the rule's
	 * error, as a throwing `handle` is: the page gets the 500 while nothing
	 * has gone out, and a cut connection after.
	 */
	| {
			readonly type: "stream";
			open(stream: ResponseStream): void | Promise<void>;
	  }
	/**
	 * Send to the network, optionally rewritten. Lower rules are skipped.
	 * `url` may be relative to the request's, and keeps its scheme:
	 * Playwright rewrites a URL within its scheme only.
	 */
	| {
			readonly type: "continue";
			readonly url?: string;
			readonly method?: string;
			readonly headers?: Readonly<Record<string, string>>;
			readonly body?: Uint8Array | string;
	  }
	/** Let the next matching rule (or the network) decide. */
	| { readonly type: "fallback" }
	/** Fail the request at the network level. */
	| { readonly type: "abort"; readonly error?: AbortErrorCode };

/** The network's answer to a request a rule passed through. */
export interface PassthroughResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	/** Undefined when the browser did not keep the body (redirects, some errors). */
	readonly body: Uint8Array | undefined;
}

export interface HttpRule {
	/** The `protocol` of the frames this rule records. */
	readonly protocol: string;
	/** Names the rule in logs and diagnostics. */
	readonly label: string;
	readonly url: UrlMatcher;
	/** Upper-case HTTP methods. Any method when omitted. */
	readonly method?: string | readonly string[];
	/** Stop matching after this many handled requests. */
	readonly times?: number;
	/** A last, request-aware condition; false falls back to the next rule. */
	readonly match?: (request: HttpRequestView) => boolean;
	/**
	 * Record the raw request and how it ended as frames. Default true. A plugin
	 * that records decoded frames of its own (Connect) turns this off. A
	 * request several recording rules of one protocol see is recorded once.
	 */
	readonly record?: boolean;
	/** The frame endpoint for a request. Defaults to the URL path. */
	readonly endpoint?: (request: HttpRequestView) => string;
	handle(request: HttpRequestView): HttpOutcome | Promise<HttpOutcome>;
	/**
	 * Called with the network's response to a request this rule passed on
	 * (`continue` or `fallback`). Not called when another rule answered it:
	 * that response is a stub's, not the network's.
	 */
	readonly onPassthroughResponse?: (
		response: PassthroughResponse,
		request: HttpRequestView,
	) => void;
	/**
	 * Called when a request this rule passed on failed at the network level,
	 * with the browser's error text (`net::ERR_CONNECTION_RESET`, ...).
	 */
	readonly onPassthroughFailure?: (
		error: string | undefined,
		request: HttpRequestView,
	) => void;
}

export interface HttpRuleHandle {
	/** Requests this rule handled (matched and decided), not merely saw. */
	readonly hits: number;
	readonly active: boolean;
	/** Stop matching, in every attached context. */
	remove(): Promise<void>;
}

/**
 * Where plugins put HTTP rules. Rules apply to every attached context, present
 * and future. Later rules win, like Playwright routes and MSW's `use()`, so a
 * test can override a suite-wide stub for one case; a rule that answers
 * `fallback` hands the request to the next one down.
 */
export interface HttpRouter {
	add(rule: HttpRule): Promise<HttpRuleHandle>;
}
