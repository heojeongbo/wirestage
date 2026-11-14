import type { Frame } from "../../../entities/frame/index.js";
import type {
	AbortErrorCode,
	HttpRequestView,
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

export interface RestRequest extends HttpRequestView {
	/** `:name` segments of the matched path. */
	readonly params: Readonly<Record<string, string>>;
	readonly query: URLSearchParams;
}

/** What a resolver answers. Build one with the helpers: `json`, `text`, `abort`, ... */
export type RestReply =
	| {
			readonly kind: "response";
			readonly status: number;
			readonly headers: Readonly<Record<string, string>>;
			readonly body?: Uint8Array | string;
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
	/** The HTTP status; undefined for an aborted or unfinished request. */
	readonly status: number | undefined;
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
	/** Recorded REST exchanges, oldest first. */
	calls(filter?: {
		readonly method?: string;
		readonly path?: RestPath;
	}): Promise<RestCall[]>;
}
