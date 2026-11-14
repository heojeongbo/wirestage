/**
 * Hand-written fakes of the Playwright ports, for the unit suite.
 *
 * A fake that is kinder than Playwright proves nothing, so these reproduce
 * what the library relies on AND what it has to survive:
 *
 * - routes run newest first and `fallback()` hands the request to the next;
 * - a request a route answered still fires `requestfinished` (fulfilled) or
 *   `requestfailed` (aborted), with the route's answer as its response;
 * - `continue({ url })` really sends the request there, so the stream server
 *   is exercised over a real socket;
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
	| { readonly kind: "network" };

export interface FakeRequestInit {
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly body?: Uint8Array | string;
	readonly page?: FakePage;
	readonly resourceType?: string;
	/** A service-worker request: `frame()` throws. */
	readonly frameless?: boolean;
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
	frame(): { page(): PagePort } {
		if (this.#init.frameless)
			throw new Error("service worker request has no frame");
		const page = this.#init.page;
		return {
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
				await entry.handler(
					{
						request: () => request,
						async fulfill(o: FulfillOptions) {
							decided = {
								kind: "fulfill",
								status: o.status ?? 200,
								headers: { ...o.headers },
								body:
									o.body === undefined ? Buffer.alloc(0) : Buffer.from(o.body),
							};
						},
						async continue(o?: ContinueOptions) {
							decided = { kind: "continue", options: o };
						},
						async fallback() {
							decided = "fallback";
						},
						async abort(error?: string) {
							decided = { kind: "abort", error };
						},
					},
					request,
				);
				if (decided === "fallback") continue;
				if (decided === undefined)
					throw new Error("route handler did not decide");
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
						// Like Playwright: a header with several values (`set-cookie`)
						// is given as one, a value per line.
						const fulfilled = new Headers();
						for (const [name, value] of Object.entries(outcome.headers))
							for (const line of value.split("\n"))
								fulfilled.append(name, line);
						return new Response(
							outcome.status === 204 ? null : new Uint8Array(outcome.body),
							{ status: outcome.status, headers: fulfilled },
						);
					}
					case "abort":
						throw new TypeError(`fetch failed: ${outcome.error}`);
					case "continue": {
						const target = outcome.options?.url ?? request.url;
						return fetch(target, {
							method: outcome.options?.method ?? request.method,
							headers: outcome.options?.headers ?? headers,
							signal: request.signal,
							...(body === undefined || request.method === "GET"
								? {}
								: { body }),
						});
					}
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
