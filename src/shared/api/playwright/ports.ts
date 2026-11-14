/**
 * The slice of Playwright the library drives, as structural types.
 *
 * Real Playwright objects satisfy these as they are — `tests/types` proves it
 * against the pinned version — so the public API takes a `BrowserContext` and
 * hands it inward unchanged. Inside, everything depends on the ports, never on
 * Playwright, which is what lets the unit suite cover every branch with
 * hand-written fakes instead of a browser.
 */

import type { CookieInit } from "../../lib/cookies/index.js";

export type HeaderMap = Readonly<Record<string, string>>;

export interface FramePort {
	evaluate<R>(
		// biome-ignore lint/suspicious/noExplicitAny: Playwright types the page function as PageFunction<Arg, R>, which unboxes Arg through a conditional type. No narrower parameter type accepts both that and the self-contained `(arg: T) => R` functions callers pass; `unknown` and `never` each fail one side. The arguments are JSON values either way.
		pageFunction: (arg: any) => R | Promise<R>,
		arg?: unknown,
	): Promise<R>;
}

export interface PagePort {
	/** The main frame and every iframe: page hooks run in each of them. */
	frames(): FramePort[];
	isClosed(): boolean;
}

export interface ResponsePort {
	status(): number;
	headers(): HeaderMap;
	body(): Promise<Buffer>;
}

export interface RequestPort {
	url(): string;
	method(): string;
	/** Playwright already lower-cases these names. */
	headers(): HeaderMap;
	/**
	 * Every header, including the ones `headers()` leaves out (cookies, and
	 * headers the network stack adds such as `last-event-id`).
	 */
	allHeaders(): Promise<HeaderMap>;
	postDataBuffer(): Buffer | null;
	resourceType(): string;
	/** Throws for requests a service worker makes; callers must guard it. */
	frame(): { page(): PagePort };
	response(): Promise<ResponsePort | null>;
	failure(): { errorText: string } | null;
}

export interface FulfillOptions {
	readonly status?: number;
	readonly headers?: Record<string, string>;
	readonly body?: string | Buffer;
}

export interface ContinueOptions {
	readonly url?: string;
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly postData?: string | Buffer;
}

export interface RoutePort {
	request(): RequestPort;
	fulfill(options: FulfillOptions): Promise<void>;
	continue(options?: ContinueOptions): Promise<void>;
	fallback(): Promise<void>;
	abort(errorCode?: string): Promise<void>;
}

export type RouteHandler = (
	route: RoutePort,
	request: RequestPort,
) => Promise<void>;

export type UrlPredicate = (url: URL) => boolean;

export interface WebSocketRoutePort {
	url(): string;
	onMessage(handler: (message: string | Buffer) => unknown): void;
	onClose(
		handler: (code: number | undefined, reason: string | undefined) => unknown,
	): void;
	send(message: string | Buffer): void;
	close(options?: { code?: number; reason?: string }): Promise<void>;
	connectToServer(): WebSocketRoutePort;
}

export interface BindingSourcePort {
	readonly page: PagePort;
}

export interface CookiePort {
	readonly name: string;
	readonly value: string;
}

/**
 * The cookie jar of a browser context: all a drive client needs of one, so
 * that is all it is given.
 */
export interface CookieJarPort {
	cookies(urls?: string | string[]): Promise<CookiePort[]>;
	/**
	 * Optional so a fake may omit it; every real BrowserContext has it. Drive
	 * clients keep the cookies a response sets here, the way Playwright's own
	 * request context does.
	 */
	addCookies?(cookies: CookieInit[]): Promise<void>;
}

export interface ContextPort extends CookieJarPort {
	/** Required here: a context always has it, and a plugin's jar calls it. */
	addCookies(cookies: CookieInit[]): Promise<void>;
	route(url: UrlPredicate, handler: RouteHandler): Promise<unknown>;
	unroute(url: UrlPredicate, handler?: RouteHandler): Promise<void>;
	routeWebSocket(
		url: UrlPredicate,
		handler: (route: WebSocketRoutePort) => unknown,
	): Promise<void>;
	addInitScript(script: { content: string }): Promise<unknown>;
	exposeBinding(
		name: string,
		binding: (source: BindingSourcePort, message: unknown) => unknown,
	): Promise<unknown>;
	pages(): PagePort[];
	/** Optional so a fake may omit it; every real BrowserContext has it. */
	grantPermissions?(
		permissions: string[],
		options?: { origin?: string },
	): Promise<void>;
	on(event: "close", listener: () => void): unknown;
	on(
		event: "requestfinished" | "requestfailed",
		listener: (request: RequestPort) => void,
	): unknown;
	off(event: "close", listener: () => void): unknown;
	off(
		event: "requestfinished" | "requestfailed",
		listener: (request: RequestPort) => void,
	): unknown;
}
