/**
 * Hand-written fakes of the Playwright ports, for the unit suite.
 *
 * A fake that is kinder than Playwright proves nothing, so these reproduce
 * what the library relies on AND what it has to survive:
 *
 * - routes run newest first and `fallback()` hands the request to the next;
 * - a route is handled once an answer starts, before Playwright checks it:
 *   a second answer is refused, and a refused first one leaves the request
 *   hanging — see `createFakeRoute`;
 * - Chromium drops a fulfilled or continued request whose headers it
 *   refuses, while Playwright reports the answer sent: the request hangs;
 * - a request a route answered still fires `requestfinished` (fulfilled) or
 *   `requestfailed` (aborted), with the route's answer as its response;
 * - `continue({ url })` really sends the request there, so the stream server
 *   is exercised over a real socket — and a response cut short fails, as in
 *   Chromium, even when the server said `connection: close`;
 * - a binding name can be exposed once per context; once removed, it is gone
 *   from every document, and a document that kept a reference to it gets a
 *   synchronous throw — while a binding that throws in Node rejects;
 * - every frame is its own realm: init scripts run in each, and a function
 *   passed to `evaluate` is serialized and rebuilt there, so one that leans
 *   on module scope fails here as it would in a browser;
 * - a navigation fires `beforeunload`, then `pagehide`, and what a document
 *   sends through a binding from `pagehide` on never arrives — Chromium
 *   loses it when the main frame navigates — while closing a page or
 *   removing an iframe fires `pagehide` and delivers;
 * - cookies are scoped: `cookies(url)` returns only those the URL would send;
 * - a WebSocket's ends pass messages on and close the way Playwright's do:
 *   see `createFakeWebSocketRoute`.
 */
import { request as httpRequest } from "node:http";

import type {
	BindingSourcePort,
	ContextPort,
	ContinueOptions,
	CookiePort,
	FramePort,
	FulfillOptions,
	PagePort,
	RequestPort,
	ResponsePort,
	RouteHandler,
	RoutePort,
	UrlPredicate,
	WebSocketRoutePort,
} from "../shared/api/playwright/index.js";
import type { CookieInit } from "../shared/lib/cookies/index.js";

export type FakeOutcome =
	| {
			readonly kind: "fulfill";
			readonly status: number;
			readonly headers: Record<string, string>;
			readonly body: Buffer;
	  }
	| { readonly kind: "continue"; readonly options: ContinueOptions | undefined }
	| { readonly kind: "abort"; readonly error: string | undefined }
	| { readonly kind: "network" }
	/**
	 * Handled, and never answered: Playwright refused the answer after it
	 * marked the route handled, or Chromium dropped it. The page waits.
	 */
	| { readonly kind: "hung" };

/** What a request's `frame()` gives: Playwright's `Frame`, as far as the ports go. */
export type FakeRequestFrame = ReturnType<RequestPort["frame"]>;

export interface FakeRequestInit {
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly body?: Uint8Array | string;
	readonly page?: FakePage;
	readonly resourceType?: string;
	/** A service-worker request: `frame()` throws. */
	readonly frameless?: boolean;
	/**
	 * The frame that sends it, for requests that must share one (a document
	 * and the requests it makes). By default a frame of its own, showing a
	 * document at the root of the request's origin.
	 */
	readonly frame?: FakeRequestFrame;
}

export class FakeRequest implements RequestPort {
	readonly #url: string;
	readonly #init: FakeRequestInit;
	responseValue: ResponsePort | null = null;
	failureText: string | undefined;

	constructor(url: string, init: FakeRequestInit) {
		this.#url = url;
		this.#init = init;
	}
	url(): string {
		return this.#url;
	}
	method(): string {
		return this.#init.method ?? "GET";
	}
	headers(): Record<string, string> {
		return { ...this.#init.headers };
	}
	allHeaders(): Promise<Record<string, string>> {
		return Promise.resolve(this.headers());
	}
	postDataBuffer(): Buffer | null {
		const body = this.#init.body;
		if (body === undefined) return null;
		return typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
	}
	resourceType(): string {
		return this.#init.resourceType ?? "fetch";
	}
	frame(): FakeRequestFrame {
		if (this.#init.frameless)
			throw new Error("service worker request has no frame");
		if (this.#init.frame !== undefined) return this.#init.frame;
		const page = this.#init.page;
		return {
			url: () => `${new URL(this.#url).origin}/`,
			page: () => {
				if (page === undefined) throw new Error("no page");
				return page;
			},
		};
	}
	response(): Promise<ResponsePort | null> {
		return Promise.resolve(this.responseValue);
	}
	failure(): { errorText: string } | null {
		return this.failureText === undefined
			? null
			: { errorText: this.failureText };
	}
}

export function fakeResponse(
	status: number,
	headers: Record<string, string>,
	body: Uint8Array | string | Error,
): ResponsePort {
	return {
		status: () => status,
		headers: () => headers,
		body: () =>
			body instanceof Error
				? Promise.reject(body)
				: Promise.resolve(Buffer.from(typeof body === "string" ? body : body)),
		// What Playwright says of a response a route made up: no server sent it.
		serverAddr: () => Promise.resolve(null),
	};
}

/** Playwright's `route.abort` codes; any other is refused. */
const ABORT_CODES = new Set([
	"aborted",
	"accessdenied",
	"addressunreachable",
	"blockedbyclient",
	"blockedbyresponse",
	"connectionaborted",
	"connectionclosed",
	"connectionfailed",
	"connectionrefused",
	"connectionreset",
	"internetdisconnected",
	"namenotresolved",
	"timedout",
	"failed",
]);

/** RFC 9110's `token`: what Chromium takes as a header name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Whether Chromium drops an answer with these headers. It refuses a name
 * that is not a token and a value with CR, LF or NUL — after Playwright has
 * split `set-cookie` into a header per line — and Playwright swallows the
 * refusal, so the answer reads as sent while the request hangs.
 */
function refusedHeaders(headers: Record<string, string> | undefined): boolean {
	return Object.entries(headers ?? {}).some(
		([name, value]) =>
			!HEADER_NAME.test(name) ||
			(name.toLowerCase() === "set-cookie" ? value.split("\n") : [value]).some(
				(line) => /[\r\n\0]/.test(line),
			),
	);
}

/**
 * Send a continued request where it now goes, failing its response as
 * Chromium does when the server closes the connection before the body is
 * whole. Node's http client does that; `fetch` takes a body for complete
 * once the server said `connection: close`, cut or not.
 */
function forward(
	url: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly signal: AbortSignal;
		readonly body: Uint8Array | undefined;
	},
): Promise<Response> {
	return new Promise<Response>((resolve, reject) => {
		const outgoing = httpRequest(
			url,
			{ method: init.method, headers: init.headers, signal: init.signal },
			(incoming) => {
				const headers = new Headers();
				for (let i = 0; i < incoming.rawHeaders.length; i += 2)
					headers.append(
						incoming.rawHeaders[i] as string,
						incoming.rawHeaders[i + 1] as string,
					);
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						incoming.on("data", (chunk: Buffer) =>
							controller.enqueue(new Uint8Array(chunk)),
						);
						incoming.on("end", () => controller.close());
						incoming.on("error", (error) =>
							controller.error(
								new TypeError("network error", { cause: error }),
							),
						);
					},
					cancel() {
						incoming.destroy();
					},
				});
				resolve(
					new Response(incoming.statusCode === 204 ? null : body, {
						status: incoming.statusCode,
						headers,
					}),
				);
			},
		);
		outgoing.on("error", (error) =>
			reject(new TypeError("fetch failed", { cause: error })),
		);
		outgoing.end(init.body === undefined ? undefined : Buffer.from(init.body));
	});
}

export interface FakeRoute extends RoutePort {
	/** An answer has started: no other is taken. */
	readonly handled: boolean;
}

/**
 * A route that takes one answer, the way Playwright's does. The route is
 * handled once an answer starts — Playwright marks it before checking the
 * answer — so a second answer is refused with "Route is already handled!",
 * whether the first was carried out or refused.
 */
export function createFakeRoute(
	request: RequestPort,
	answers: Partial<Omit<RoutePort, "request">>,
): FakeRoute {
	let handled = false;
	const answer =
		<Args extends unknown[]>(
			carryOut: ((...args: Args) => Promise<void>) | undefined,
		) =>
		async (...args: Args): Promise<void> => {
			if (handled) throw new Error("Route is already handled!");
			handled = true;
			await carryOut?.(...args);
		};
	return {
		get handled() {
			return handled;
		},
		request: () => request,
		fulfill: answer(answers.fulfill),
		continue: answer(answers.continue),
		fallback: answer(answers.fallback),
		abort: answer(answers.abort),
	};
}

type Listener = (value?: unknown) => void;

type Scope = Record<string, unknown> & EventTarget;

export interface FakeFrame extends FramePort {
	/** The global of the frame's current document. */
	readonly scope: Scope;
	/** Run the context's init scripts in this frame's scope, as a navigation would. */
	load(): void;
	/**
	 * Load a new document, as a navigation does: `beforeunload`, then
	 * `pagehide` — from which the old document's binding calls are lost —
	 * then the init scripts in a fresh realm.
	 */
	navigate(): void;
	/** The frame is removed: `pagehide`, then `evaluate` fails, as on a detached frame. */
	detach(): void;
}

export interface FakePage extends PagePort {
	/** The main frame's scope. */
	readonly scope: Scope;
	/** Load the main frame. */
	load(): void;
	/** The main frame navigates. */
	navigate(): void;
	/** `pagehide` in every frame, then closed. */
	close(): void;
	/** Add an iframe: a realm of its own, with the same bindings and scripts. */
	addFrame(): FakeFrame;
	frames(): FakeFrame[];
}

export interface FakeWebSocketRoute extends WebSocketRoutePort {
	readonly sent: (string | Buffer)[];
	/** Closes this end carried out, with the options given. */
	readonly closedWith: ({ code?: number; reason?: string } | undefined)[];
	/** Closes dropped because a browser refuses them. */
	readonly refusedCloses: ({ code?: number; reason?: string } | undefined)[];
	/**
	 * `closing` is the page's socket after `socket.close()`: it stays there,
	 * with no `close` event, until the route closes the page's end.
	 */
	readonly state: "open" | "closing" | "closed";
	/** The page (or, for a server side, the server) sends a message. */
	receive(message: string | Buffer): void;
	/** This end closes by its own doing. */
	closeFromPeer(code?: number, reason?: string): void;
	server: FakeWebSocketRoute | undefined;
}

/**
 * Whether the browser's own `WebSocket.close(code, reason)` carries the
 * close out: it throws on a code outside 1000 and 3000-4999, on a reason
 * without a code (the missing code is read as 0), and on a reason over 123
 * bytes of UTF-8.
 */
const closable = (options: { code?: number; reason?: string } | undefined) =>
	(options?.reason === undefined || Buffer.byteLength(options.reason) <= 123) &&
	(options?.code === undefined
		? options?.reason === undefined
		: options.code === 1000 || (options.code >= 3000 && options.code <= 4999));

/**
 * One end of a routed WebSocket, behaving as Playwright 1.60's does
 * (`webSocketMockSource` and the client's `WebSocketRoute`):
 *
 * - with no `onMessage` handler, an end passes its messages on: the
 *   server's to the page, the page's to the server once it is connected;
 * - every close of an end is reported to that end's `onClose` handler — the
 *   one the end started itself, and the one the route carried out, which for
 *   a close the page started means the handler runs twice;
 * - with no handler, a close is forwarded to the other end instead;
 * - the page's end takes any close code and reason; the server's end is
 *   closed with the browser's own `WebSocket.close()`, which throws on a
 *   code outside 1000 and 3000-4999, on a reason without a code and on a
 *   reason over 123 bytes — and Playwright swallows that, so nothing closes.
 */
export function createFakeWebSocketRoute(
	url: string,
	page?: FakeWebSocketRoute,
): FakeWebSocketRoute {
	const isServer = page !== undefined;
	let onMessage: ((m: string | Buffer) => unknown) | undefined;
	let onClose:
		| ((code: number | undefined, reason: string | undefined) => unknown)
		| undefined;
	let state: FakeWebSocketRoute["state"] = "open";
	const report = (code: number | undefined, reason: string | undefined) => {
		if (onClose !== undefined) onClose(code, reason);
		else
			void (page ?? route.server)?.close({
				...(code === undefined ? {} : { code }),
				...(reason === undefined ? {} : { reason }),
			});
	};
	const route: FakeWebSocketRoute = {
		sent: [],
		closedWith: [],
		refusedCloses: [],
		server: undefined,
		get state() {
			return state;
		},
		url: () => url,
		onMessage(handler) {
			onMessage = handler;
		},
		onClose(handler) {
			onClose = handler;
		},
		send(message) {
			route.sent.push(message);
		},
		async close(options) {
			if (state === "closed") {
				// The server's socket is gone already: Playwright reports the
				// close once more. The page's end simply stays closed.
				if (isServer) report(options?.code, options?.reason);
				return;
			}
			if (isServer && !closable(options)) {
				route.refusedCloses.push(options);
				return;
			}
			state = "closed";
			route.closedWith.push(options);
			report(options?.code, options?.reason);
		},
		connectToServer() {
			route.server ??= createFakeWebSocketRoute(url, route);
			return route.server;
		},
		receive(message) {
			if (onMessage !== undefined) onMessage(message);
			else (page ?? route.server)?.send(message);
		},
		closeFromPeer(code, reason) {
			if (state !== "open") return;
			// The server's socket is closed once it says so; the page's waits
			// for the route to complete the close.
			state = isServer ? "closed" : "closing";
			report(code, reason);
		},
	};
	return route;
}

export interface FakeContext extends ContextPort {
	readonly scripts: string[];
	readonly bindings: Map<
		string,
		(source: BindingSourcePort, message: unknown) => unknown
	>;
	/** Cookies with no `domain` go to every URL, for tests that do not care. */
	cookieJar: (CookiePort & Partial<Pick<CookieInit, "domain" | "path">>)[];
	readonly cookieRequests: (string | string[] | undefined)[];
	/** What `addCookies` was given, in order. */
	readonly addedCookies: CookieInit[];
	newPage(): FakePage;
	/** Send a request through the routes, newest first. */
	dispatch(
		url: string,
		init?: FakeRequestInit,
	): Promise<{ outcome: FakeOutcome; request: FakeRequest }>;
	/** A `fetch` that goes through the routes; `continue({ url })` really fetches. */
	fetch(options?: {
		readonly network?: (input: Request) => Promise<Response>;
		readonly page?: FakePage;
	}): typeof fetch;
	emit(
		event: "requestfinished" | "requestfailed" | "close",
		value?: unknown,
	): void;
	/** Open a WebSocket through the routes; returns the route the handler got, if any. */
	openWebSocket(url: string): Promise<FakeWebSocketRoute | undefined>;
	readonly routeCount: number;
	failNextUnroute?: boolean;
	disposables: { dispose(): Promise<void> }[] | undefined;
}

export function createFakeContext(
	options: { readonly disposables?: boolean } = {},
): FakeContext {
	const routes: { predicate: UrlPredicate; handler: RouteHandler }[] = [];
	const wsRoutes: {
		predicate: UrlPredicate;
		handler: (route: WebSocketRoutePort) => unknown;
	}[] = [];
	const listeners = new Map<string, Set<Listener>>();
	const pages: FakePage[] = [];
	const scripts: string[] = [];
	const bindings = new Map<
		string,
		(source: BindingSourcePort, message: unknown) => unknown
	>();
	const disposables = options.disposables
		? ([] as { dispose(): Promise<void> }[])
		: undefined;
	const disposable = () => {
		if (disposables === undefined) return undefined;
		const handle = { dispose: async () => {} };
		disposables.push(handle);
		return handle;
	};

	const context: FakeContext = {
		scripts,
		bindings,
		cookieJar: [],
		cookieRequests: [],
		addedCookies: [],
		disposables,
		get routeCount() {
			return routes.length;
		},
		async route(predicate, handler) {
			routes.push({ predicate, handler });
			return disposable();
		},
		async unroute(predicate, handler) {
			if (context.failNextUnroute) {
				context.failNextUnroute = false;
				throw new Error("Target closed");
			}
			const index = routes.findIndex(
				(r) => r.predicate === predicate && r.handler === handler,
			);
			if (index >= 0) routes.splice(index, 1);
		},
		async routeWebSocket(predicate, handler) {
			wsRoutes.push({ predicate, handler });
		},
		async addInitScript(script) {
			scripts.push(script.content);
			const handle = disposable();
			if (handle !== undefined)
				handle.dispose = async () => {
					scripts.splice(scripts.indexOf(script.content), 1);
				};
			return handle;
		},
		async exposeBinding(name, binding) {
			if (bindings.has(name))
				throw new Error(`Function "${name}" has been already registered`);
			bindings.set(name, binding);
			const handle = disposable();
			if (handle !== undefined)
				handle.dispose = async () => {
					bindings.delete(name);
					for (const page of pages)
						for (const frame of page.frames()) delete frame.scope[name];
				};
			return handle;
		},
		pages: () => pages,
		async cookies(urls) {
			context.cookieRequests.push(urls);
			if (urls === undefined) return context.cookieJar;
			const targets = (typeof urls === "string" ? [urls] : urls).map(
				(url) => new URL(url),
			);
			return context.cookieJar.filter(
				({ domain, path }) =>
					domain === undefined ||
					targets.some(
						({ hostname, pathname }) =>
							(domain.startsWith(".")
								? hostname === domain.slice(1) || hostname.endsWith(domain)
								: hostname === domain) && pathname.startsWith(path ?? "/"),
					),
			);
		},
		async addCookies(cookies) {
			context.addedCookies.push(...cookies);
			context.cookieJar = [
				...context.cookieJar.filter(
					(kept) =>
						!cookies.some(
							(cookie) =>
								cookie.name === kept.name && cookie.domain === kept.domain,
						),
				),
				...cookies.map(({ name, value, domain, path }) => ({
					name,
					value,
					domain,
					path,
				})),
			];
		},
		on(event: string, listener: (value: never) => void) {
			const set = listeners.get(event) ?? new Set();
			set.add(listener as Listener);
			listeners.set(event, set);
			return context;
		},
		off(event: string, listener: (value: never) => void) {
			listeners.get(event)?.delete(listener as Listener);
			return context;
		},
		emit(event, value) {
			for (const listener of [...(listeners.get(event) ?? [])]) listener(value);
		},
		newPage() {
			const page = createFakePage(context);
			pages.push(page);
			return page;
		},
		async dispatch(url, init = {}) {
			const request = new FakeRequest(url, init);
			const parsed = new URL(url);
			for (let i = routes.length - 1; i >= 0; i--) {
				const entry = routes[i];
				if (entry === undefined || !entry.predicate(parsed)) continue;
				let decided: FakeOutcome | "fallback" | undefined;
				const route = createFakeRoute(request, {
					async fulfill(o: FulfillOptions) {
						decided = refusedHeaders(o.headers)
							? { kind: "hung" }
							: {
									kind: "fulfill",
									status: o.status ?? 200,
									headers: { ...o.headers },
									body:
										o.body === undefined
											? Buffer.alloc(0)
											: Buffer.from(o.body),
								};
					},
					async continue(o?: ContinueOptions) {
						// Playwright's own check, made after the route is handled; a
						// relative URL fails it too ("Invalid URL").
						if (o?.url && new URL(o.url).protocol !== parsed.protocol)
							throw new Error(
								"New URL must have same protocol as overridden URL",
							);
						decided = refusedHeaders(o?.headers)
							? { kind: "hung" }
							: { kind: "continue", options: o };
					},
					async fallback() {
						decided = "fallback";
					},
					async abort(error?: string) {
						if (error !== undefined && !ABORT_CODES.has(error))
							throw new Error(`Unknown error code: ${error}`);
						decided = { kind: "abort", error };
					},
				});
				await entry.handler(route, request);
				if (decided === "fallback") continue;
				if (decided === undefined) {
					if (!route.handled) throw new Error("route handler did not decide");
					// Its one answer was refused: nothing else will be taken.
					decided = { kind: "hung" };
				}
				// Like Playwright: a request a route answered still finishes or
				// fails, with the route's answer as its response.
				if (decided.kind === "fulfill") {
					request.responseValue = fakeResponse(
						decided.status,
						decided.headers,
						decided.body,
					);
					context.emit("requestfinished", request);
				} else if (decided.kind === "abort") {
					request.failureText = decided.error ?? "failed";
					context.emit("requestfailed", request);
				}
				return { outcome: decided, request };
			}
			return { outcome: { kind: "network" }, request };
		},
		fetch({ network, page } = {}) {
			return (async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				const headers: Record<string, string> = {};
				request.headers.forEach((value, name) => {
					headers[name] = value;
				});
				const body =
					request.body === null
						? undefined
						: new Uint8Array(await request.arrayBuffer());
				const { outcome, request: dispatched } = await context.dispatch(
					request.url,
					{
						method: request.method,
						headers,
						...(body === undefined ? {} : { body }),
						...(page === undefined ? {} : { page }),
					},
				);
				switch (outcome.kind) {
					case "fulfill": {
						// Like Playwright: `set-cookie` takes several values, a value
						// per line; any other header is sent as given.
						const fulfilled = new Headers();
						for (const [name, value] of Object.entries(outcome.headers))
							for (const line of name.toLowerCase() === "set-cookie"
								? value.split("\n")
								: [value])
								fulfilled.append(name, line);
						return new Response(
							outcome.status === 204 ? null : new Uint8Array(outcome.body),
							{ status: outcome.status, headers: fulfilled },
						);
					}
					case "abort":
						throw new TypeError(`fetch failed: ${outcome.error}`);
					case "hung":
						// Nothing ever comes; only the page giving up ends it.
						return new Promise<Response>((_resolve, reject) => {
							request.signal.addEventListener(
								"abort",
								() => reject(request.signal.reason),
								{ once: true },
							);
						});
					case "continue":
						return forward(outcome.options?.url ?? request.url, {
							method: outcome.options?.method ?? request.method,
							headers: outcome.options?.headers ?? headers,
							signal: request.signal,
							body: request.method === "GET" ? undefined : body,
						});
					case "network": {
						if (network === undefined)
							return new Response("no network", { status: 502 });
						// Like Playwright: the body is complete before requestfinished fires.
						const real = await network(
							new Request(request.url, {
								method: request.method,
								headers,
								...(body === undefined ? {} : { body }),
							}),
						);
						const buffered = new Uint8Array(await real.arrayBuffer());
						const responseHeaders: Record<string, string> = {};
						real.headers.forEach((value, name) => {
							responseHeaders[name] = value;
						});
						dispatched.responseValue = fakeResponse(
							real.status,
							responseHeaders,
							buffered,
						);
						context.emit("requestfinished", dispatched);
						return new Response(buffered, {
							status: real.status,
							headers: real.headers,
						});
					}
				}
			}) as typeof fetch;
		},
		async openWebSocket(url) {
			const parsed = new URL(url);
			for (let i = wsRoutes.length - 1; i >= 0; i--) {
				const entry = wsRoutes[i];
				if (entry === undefined || !entry.predicate(parsed)) continue;
				const route = createFakeWebSocketRoute(url);
				await entry.handler(route);
				return route;
			}
			return undefined;
		},
	};
	return context;
}

export function createFakePage(context: FakeContext): FakePage {
	let closed = false;
	const frames: FakeFrame[] = [];
	const addFrame = (): FakeFrame => {
		let scope = new EventTarget() as Scope;
		let detached = false;
		const frame: FakeFrame = {
			get scope() {
				return scope;
			},
			async evaluate(pageFunction, arg) {
				if (closed || detached)
					throw new Error("Target page, context or browser has been closed");
				// Rebuilt from its source, with this frame's scope as its global:
				// what Playwright does, and what makes a closure over module
				// scope fail here instead of in a browser. `__name` is what a
				// transpiler's keepNames leaves in the source.
				const rebuilt = new Function(
					"globalThis",
					`const __name = (target) => target; return (${pageFunction.toString()});`,
				)(scope) as typeof pageFunction;
				return rebuilt(arg as never);
			},
			load() {
				const document = scope;
				for (const [name, binding] of context.bindings)
					document[name] = (message: unknown) => {
						// Like Playwright's: removed, it throws, and synchronously.
						if (context.bindings.get(name) !== binding)
							throw new Error(`binding "${name}" has been removed`);
						// A document that navigated away is gone, and its call with it.
						if (document !== scope) return new Promise(() => {});
						// A binding that throws in Node rejects in the page.
						return new Promise((resolve) =>
							resolve(binding({ page }, message)),
						);
					};
				for (const content of context.scripts)
					new Function("globalThis", content)(document);
			},
			navigate() {
				const leaving = scope;
				leaving.dispatchEvent(new Event("beforeunload"));
				scope = new EventTarget() as Scope;
				leaving.dispatchEvent(new Event("pagehide"));
				frame.load();
			},
			detach() {
				scope.dispatchEvent(new Event("pagehide"));
				detached = true;
			},
		};
		frames.push(frame);
		return frame;
	};
	const page: FakePage = {
		get scope() {
			return main.scope;
		},
		isClosed: () => closed,
		close() {
			for (const frame of frames)
				frame.scope.dispatchEvent(new Event("pagehide"));
			closed = true;
		},
		frames: () => frames,
		addFrame,
		load() {
			main.load();
		},
		navigate() {
			main.navigate();
		},
	};
	const main = addFrame();
	return page;
}
