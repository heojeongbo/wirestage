import type { FrameInit, Timeline } from "../../../entities/frame/index.js";
import type {
	AbortErrorCode,
	HttpOutcome,
	HttpRequestView,
	HttpRouter,
	HttpRule,
	HttpRuleHandle,
	PassthroughResponse,
	StreamEnd,
} from "../../../entities/plugin/index.js";
import {
	createResponseStream,
	type ServedStream,
} from "../../../shared/api/http-server/index.js";
import type {
	PagePort,
	RequestPort,
	RouteHandler,
	RoutePort,
	UrlPredicate,
} from "../../../shared/api/playwright/index.js";
import type {
	NodeHandler,
	StreamServer,
	StreamSession,
} from "../../../shared/api/stream-server/index.js";
import { toBuffer, toBytes, utf8 } from "../../../shared/lib/bytes/index.js";
import type { Clock } from "../../../shared/lib/clock/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type { ScopedLogger } from "../../../shared/lib/logger/index.js";
import { compileUrlMatcher } from "../../../shared/lib/match/index.js";
import type { AttachedContext } from "./attached-context.js";

export interface HttpRouterDeps {
	readonly timeline: Timeline;
	readonly log: ScopedLogger;
	readonly streams: Pick<StreamServer, "open">;
	readonly pageId: (page: PagePort) => string;
	readonly correlation: () => string;
	readonly clock: Clock;
	/**
	 * How long the browser may take over what the router waits on: handing
	 * over a passed-through response's body, which a dialog holds back, and
	 * bringing a live stream's request to the stream server.
	 */
	readonly timeoutMs: number;
}

export interface HttpRouterEngine extends HttpRouter {
	attach(attachment: AttachedContext): Promise<void>;
	detach(attachment: AttachedContext): Promise<void>;
	/**
	 * Wait for what is on its way to the timeline: the responses that came
	 * back — reading one is a round trip to the browser, waited on for
	 * `timeoutMs` at most — and the ends of the streams a stub closed.
	 */
	settle(): Promise<void>;
}

interface Entry {
	readonly rule: HttpRule;
	readonly matchesUrl: (url: URL) => boolean;
	readonly methods: ReadonlySet<string> | undefined;
	remaining: number | undefined;
	hits: number;
	active: boolean;
}

type RequestFrame = ReturnType<RequestPort["frame"]>;

/**
 * One request, as every rule that sees it shares it: one view, one
 * correlation id, one raw request frame per protocol.
 */
interface Exchange {
	readonly view: HttpRequestView;
	readonly attachment: AttachedContext;
	readonly route: RoutePort;
	readonly request: RequestPort;
	/** The frame that sent it; undefined for a service worker's request. */
	readonly frame: RequestFrame | undefined;
	/** Protocol → endpoint of the raw request frames on the timeline. */
	readonly recorded: Map<string, string>;
	/** Rules that passed the request on, newest first. */
	readonly passed: Entry[];
}

interface Installed {
	readonly predicate: UrlPredicate;
	readonly handler: RouteHandler;
}

interface Listeners {
	readonly finished: (request: RequestPort) => void;
	readonly failed: (request: RequestPort) => void;
}

/** A live stream redirected to the stream server, before the browser comes. */
interface Unclaimed {
	readonly attachment: AttachedContext;
	/** Stop waiting: the browser came, or `frame` says why it never will. */
	readonly settle: (frame?: Closing) => void;
}

/** A frame that ends an exchange, before the exchange's own fields. */
type Closing = Omit<
	FrameInit,
	"protocol" | "endpoint" | "page" | "context" | "correlation"
>;

type Answer = Exclude<HttpOutcome, { readonly type: "fallback" }>;

/**
 * How each outcome is carried out. A table keyed by the outcome's `type`,
 * not a `switch`: an outcome added to the union and not here is a compile
 * error, where a missing `case` would let the request hang.
 *
 * Each checks its answer before it touches the route: Playwright marks a
 * route handled before it checks an answer, so one it refuses would leave
 * no way to tell the page anything.
 */
type Executors = {
	readonly [Type in Answer["type"]]: (
		outcome: Extract<Answer, { readonly type: Type }>,
		exchange: Exchange,
		entry: Entry,
	) => Promise<void>;
};

/**
 * Playwright's abort codes. Keyed by the contract's type, so the two cannot
 * drift: a code missing here, or one too many, does not compile.
 */
const ABORT_CODES: Readonly<Record<AbortErrorCode, true>> = {
	aborted: true,
	accessdenied: true,
	addressunreachable: true,
	blockedbyclient: true,
	blockedbyresponse: true,
	connectionaborted: true,
	connectionclosed: true,
	connectionfailed: true,
	connectionrefused: true,
	connectionreset: true,
	internetdisconnected: true,
	namenotresolved: true,
	timedout: true,
	failed: true,
};

/** RFC 9110's `token`: what a header name may be made of. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A host whose http pages are secure contexts. */
const LOOPBACK_HOST = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/** A loopback address, as Chromium reports the server of a response. */
const LOOPBACK_ADDRESS = /^(127\.|::ffff:127\.|\[?::1\]?$)/;

/**
 * Refuse a header Chromium refuses: a name that is not a token, a value
 * with a line break or NUL. Playwright reports such an answer sent while
 * Chromium never sends it, and the request hangs.
 */
function checkHeader(name: string, value: string): void {
	if (!HEADER_NAME.test(name))
		throw new WirestageError(
			"INVALID_ARGUMENT",
			`${JSON.stringify(name)} is not a valid header name`,
		);
	if (/[\r\n\0]/.test(value))
		throw new WirestageError(
			"INVALID_ARGUMENT",
			`the value of header "${name}" has a line break or NUL in it`,
		);
}

/**
 * A fulfill's headers, as Chromium takes them. A value may carry several,
 * one per line: Playwright sends `set-cookie` as a header line each, and
 * any other header is folded into one value, `, `-separated, as HTTP joins
 * repeated header lines.
 */
function fulfillHeaders(
	headers: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const sent: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const values = value.split("\n");
		for (const each of values) checkHeader(name, each);
		sent[name] =
			name.toLowerCase() === "set-cookie" ? value : values.join(", ");
	}
	return sent;
}

/** Where a `continue` goes: relative to the request, in its scheme. */
function continueUrl(target: string, request: URL): string {
	const url = new URL(target, request);
	if (url.protocol !== request.protocol)
		throw new WirestageError(
			"INVALID_ARGUMENT",
			`continue cannot change the scheme (${request.protocol} to ${url.protocol}): Playwright rewrites a URL within its scheme only`,
		);
	return url.href;
}

/** Whether a page at `url` is a secure context: https, or http on loopback. */
const isSecure = ({ protocol, hostname }: URL): boolean =>
	protocol === "https:" ||
	(protocol === "http:" && LOOPBACK_HOST.test(hostname));

/** A request the browser reports failed, with its error text. */
const networkFault = (error: string | undefined): Closing => ({
	kind: "fault",
	direction: "none",
	source: "network",
	meta: { reason: "network", error },
});

/** A live stream whose request never reached the stream server. */
const unreached = (error: string): Closing => ({
	kind: "fault",
	direction: "none",
	source: "stub",
	meta: { reason: "unreached", error },
});

/** How a stream that ran its course is on record. */
const endOf = (end: StreamEnd): Closing =>
	end === "cut"
		? {
				kind: "fault",
				direction: "none",
				source: "stub",
				meta: { reason: "cut" },
			}
		: {
				kind: "lifecycle",
				direction: "none",
				// The page let go of it, or the stub ended it.
				source: end === "cancelled" ? "page" : "stub",
				meta: { event: "close", end },
			};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Turns HTTP rules into ONE Playwright route per attached context and runs
 * the chain itself: the newest rule that matches decides, and a `fallback`
 * hands the request to the next.
 *
 * Running the chain here, rather than as one Playwright route per rule, is
 * what makes a request one exchange however many rules see it: they share a
 * view and a correlation id, `times` is claimed without an await between the
 * check and the count, and a rule that passed a request on hears about the
 * network's answer only when the network really gave one.
 */
export function createHttpRouter(deps: HttpRouterDeps): HttpRouterEngine {
	/** Active rules, oldest first. */
	const entries: Entry[] = [];
	const attachments = new Map<AttachedContext, Listeners>();
	const routes = new Map<AttachedContext, Promise<Installed>>();
	const pending = new WeakMap<RequestPort, Exchange>();
	/** Live streams whose request the browser has not brought yet. */
	const unclaimed = new Map<RequestPort, Unclaimed>();
	/** Live streams the stream server is serving. */
	const serving = new Set<ServedStream>();
	/** Where each frame's document came from, as its navigation reported. */
	const documents = new WeakMap<
		RequestFrame,
		{ readonly origin: string; readonly loopback: boolean }
	>();
	/** Responses being read off the browser, on their way to the timeline. */
	const settling = new Set<Promise<void>>();

	/**
	 * The origin a live stream from `frame` needs `local-network-access`
	 * for, if any. Chromium's Local Network Access stops a page it cannot
	 * place in an address space — any page a route fulfilled — from reaching
	 * the loopback stream server unless its origin holds the permission. A
	 * page a loopback server really served needs none, and one that is not a
	 * secure context is refused loopback, granted or not.
	 */
	const grantFor = (frame: RequestFrame | undefined): string | undefined => {
		// A service worker's request has no frame, and a frame that has shown
		// no document yet no URL: neither has an origin to grant.
		if (frame === undefined || !URL.canParse(frame.url())) return undefined;
		const url = new URL(frame.url());
		if (!isSecure(url)) return undefined;
		const document = documents.get(frame);
		return document?.origin === url.origin && document.loopback
			? undefined
			: url.origin;
	};

	/**
	 * Granted per stream, to that page's origin alone: Playwright merges it
	 * with the grants the test made for that origin, and a test that cleared
	 * its permissions has it back with the next stream. A browser without
	 * the permission refuses it, and then needs none.
	 */
	const allowLocalNetwork = async ({
		attachment,
		frame,
	}: Exchange): Promise<void> => {
		const origin = grantFor(frame);
		if (origin === undefined) return;
		try {
			await attachment.context.grantPermissions?.(["local-network-access"], {
				origin,
			});
		} catch (error) {
			deps.log.debug("local-network-access not granted", { origin }, error);
		}
	};

	/** Note where a frame's document came from, for `grantFor`. */
	const noteDocument = async (request: RequestPort): Promise<void> => {
		try {
			const frame = request.frame();
			const server = await (await request.response())?.serverAddr();
			documents.set(frame, {
				origin: new URL(request.url()).origin,
				loopback: server != null && LOOPBACK_ADDRESS.test(server.ipAddress),
			});
		} catch (error) {
			// A service worker's document has no frame, a closed page no answer.
			deps.log.debug(
				"could not tell where a document came from",
				{ url: request.url() },
				error,
			);
		}
	};

	/** The frame and the page a request came from; a service worker's has neither. */
	const senderOf = (
		request: RequestPort,
	): { readonly frame?: RequestFrame; readonly page?: string } => {
		try {
			const frame = request.frame();
			return { frame, page: deps.pageId(frame.page()) };
		} catch {
			// Service-worker requests have no frame.
			return {};
		}
	};

	const createView = async (
		request: RequestPort,
		attachment: AttachedContext,
		url: URL,
		page: string | undefined,
	): Promise<HttpRequestView> => {
		let body: Uint8Array | undefined;
		let correlation: string | undefined;
		const getBody = () => {
			body ??= toBytes(request.postDataBuffer() ?? new Uint8Array(0));
			return body;
		};
		return {
			get correlation() {
				correlation ??= deps.correlation();
				return correlation;
			},
			method: request.method(),
			url,
			headers: await request.allHeaders(),
			page,
			context: attachment.id,
			resourceType: request.resourceType(),
			body: getBody,
			text: () => utf8(getBody()),
			json: <T>() => JSON.parse(utf8(getBody())) as T,
		};
	};

	const append = (
		{ view }: Exchange,
		protocol: string,
		endpoint: string,
		frame: Closing,
	) =>
		deps.timeline.append({
			...frame,
			protocol,
			endpoint,
			page: view.page,
			context: view.context,
			correlation: view.correlation,
		});

	/** End the exchange for every protocol that recorded its request. */
	const close = (exchange: Exchange, frame: Closing) => {
		for (const [protocol, endpoint] of exchange.recorded)
			append(exchange, protocol, endpoint, frame);
	};

	/**
	 * A rule's URL test, which is the caller's code when the rule was given a
	 * predicate. Playwright calls this for every request of the context, so
	 * one that throws would break them all: it counts as "no match" instead.
	 */
	const wants = (entry: Entry, url: URL): boolean => {
		try {
			return entry.matchesUrl(url);
		} catch (error) {
			deps.log.error(
				"rule's URL matcher failed",
				{ rule: entry.rule.label, url: url.href },
				error,
			);
			return false;
		}
	};

	/** The rule's name for the request; the path when it has none to give. */
	const nameOf = ({ rule }: Entry, view: HttpRequestView): string => {
		try {
			return rule.endpoint?.(view) ?? view.url.pathname;
		} catch {
			// Reached only while reporting a rule that already failed.
			return view.url.pathname;
		}
	};

	const retire = (entry: Entry) => {
		if (!entry.active) return;
		entry.active = false;
		entries.splice(entries.indexOf(entry), 1);
	};

	/**
	 * Whether `entry` takes the request, and its decision if so. The checks
	 * and the count are one synchronous step: two requests in flight cannot
	 * both take the last of a rule's `times`.
	 */
	const decide = async (
		entry: Entry,
		exchange: Exchange,
	): Promise<HttpOutcome | undefined> => {
		const { rule } = entry;
		const { view } = exchange;
		if (!entry.active) return undefined;
		if (entry.methods !== undefined && !entry.methods.has(view.method))
			return undefined;
		if (rule.match !== undefined && !rule.match(view)) return undefined;
		entry.hits += 1;
		if (entry.remaining !== undefined && --entry.remaining === 0) retire(entry);
		if (rule.record !== false && !exchange.recorded.has(rule.protocol)) {
			const endpoint = rule.endpoint?.(view) ?? view.url.pathname;
			exchange.recorded.set(rule.protocol, endpoint);
			append(exchange, rule.protocol, endpoint, {
				kind: "request",
				direction: "out",
				source: "page",
				data: () => view.body(),
				meta: {
					method: view.method,
					url: view.url.href,
					headers: view.headers,
				},
			});
		}
		return rule.handle(view);
	};

	/** The request goes to the network: remember who wants to hear the answer. */
	const track = (exchange: Exchange) => {
		if (
			exchange.recorded.size > 0 ||
			exchange.passed.some(
				({ rule }) =>
					rule.onPassthroughResponse !== undefined ||
					rule.onPassthroughFailure !== undefined,
			)
		)
			pending.set(exchange.request, exchange);
	};

	/** A request that outlived its context fails for that reason alone. */
	const levelOf = ({ attachment }: Exchange): "error" | "debug" =>
		attachments.has(attachment) ? "error" : "debug";

	/** What the page is told of a rule that failed; the app may display it. */
	const failureBody = ({ rule }: Entry, error: unknown): string =>
		`wirestage: rule "${rule.label}" failed: ${messageOf(error)}`;

	/** Say which rule failed: in the log, and on the timeline. */
	const report = (exchange: Exchange, entry: Entry, error: unknown) => {
		const { rule } = entry;
		deps.log[levelOf(exchange)](
			"rule failed",
			{ rule: rule.label, url: exchange.view.url.href },
			error,
		);
		append(exchange, rule.protocol, nameOf(entry, exchange.view), {
			kind: "fault",
			direction: "none",
			source: "stub",
			meta: { reason: "rule-error", error: messageOf(error) },
		});
	};

	/**
	 * Serve a live stream once the browser has brought its request to the
	 * stream server. A rule that throws there is a rule that failed, as a
	 * throwing `fulfill` is — not the page letting go.
	 */
	const serveStream =
		(
			outcome: Extract<Answer, { readonly type: "stream" }>,
			exchange: Exchange,
			entry: Entry,
		): NodeHandler =>
		async (request, response) => {
			const served = createResponseStream(request, response, (end, failed) => {
				serving.delete(served);
				// A rule that failed is on record as its error, not as an end.
				if (!failed) close(exchange, endOf(end));
			});
			serving.add(served);
			try {
				await outcome.open(served.stream);
			} catch (error) {
				if (served.fail(failureBody(entry, error)))
					report(exchange, entry, error);
				// It was over first, and is on record as such: a write into a
				// connection the page let go of, or one the rule ended.
				else
					deps.log.debug(
						"a stream's rule failed after the stream was over",
						{ rule: entry.rule.label },
						error,
					);
			}
		};

	/**
	 * Wait for the browser to bring a redirected stream to the stream
	 * server. Until it does, the session holds a place on a listener and the
	 * exchange has no end — and a page that let go first, while the rule
	 * decided or just after the redirect, never comes: Playwright takes the
	 * redirect all the same. Given up when the request fails, the context is
	 * detached, or `timeoutMs` passes.
	 */
	const awaitBrowser = (exchange: Exchange, session: StreamSession): void => {
		const release = (frame: Closing) => {
			session.dispose();
			close(exchange, frame);
		};
		const failure = exchange.request.failure();
		if (failure !== null) {
			// It failed while the rule decided or the redirect was made.
			release(networkFault(failure.errorText));
			return;
		}
		const deadline = new AbortController();
		const settle = (frame?: Closing) => {
			unclaimed.delete(exchange.request);
			deadline.abort();
			if (frame !== undefined) release(frame);
		};
		unclaimed.set(exchange.request, {
			attachment: exchange.attachment,
			settle,
		});
		void deps.clock.sleep(deps.timeoutMs, deadline.signal).then(
			() => {
				deps.log.warn(
					"a live stream's request never reached the stream server, and was given up",
					{ url: exchange.view.url.href, timeoutMs: deps.timeoutMs },
				);
				settle(
					unreached(
						`the browser did not bring the request to the stream server within ${deps.timeoutMs} ms`,
					),
				);
			},
			// It came, failed or was detached first.
			() => undefined,
		);
	};

	const execute: Executors = {
		async fulfill(outcome, exchange) {
			const status = outcome.status ?? 200;
			const headers = fulfillHeaders(outcome.headers);
			const body =
				outcome.body === undefined ? undefined : toBytes(outcome.body);
			await exchange.route.fulfill(
				body === undefined
					? { status, headers }
					: { status, headers, body: toBuffer(body) },
			);
			close(exchange, {
				kind: "response",
				direction: "in",
				source: "stub",
				...(body === undefined ? {} : { data: body }),
				meta: { status, headers },
			});
		},
		async stream(outcome, exchange, entry) {
			let claimed = false;
			const serve = serveStream(outcome, exchange, entry);
			const session = await deps.streams.open(
				(request, response) => {
					claimed = true;
					unclaimed.get(exchange.request)?.settle();
					return serve(request, response);
				},
				{ secure: exchange.view.url.protocol === "https:" },
			);
			await allowLocalNetwork(exchange);
			try {
				await exchange.route.continue({ url: session.url });
			} catch (error) {
				session.dispose();
				throw error;
			}
			// The browser may come before Playwright says the redirect is made.
			if (!claimed) awaitBrowser(exchange, session);
		},
		async continue(outcome, exchange, entry) {
			const url =
				outcome.url === undefined
					? undefined
					: continueUrl(outcome.url, exchange.view.url);
			for (const [name, value] of Object.entries(outcome.headers ?? {}))
				checkHeader(name, value);
			exchange.passed.push(entry);
			track(exchange);
			await exchange.route.continue({
				...(url === undefined ? {} : { url }),
				...(outcome.method === undefined ? {} : { method: outcome.method }),
				...(outcome.headers === undefined
					? {}
					: { headers: { ...outcome.headers } }),
				...(outcome.body === undefined
					? {}
					: { postData: toBuffer(toBytes(outcome.body)) }),
			});
		},
		async abort(outcome, exchange) {
			const error = outcome.error ?? "failed";
			if (!Object.hasOwn(ABORT_CODES, error))
				throw new WirestageError(
					"INVALID_ARGUMENT",
					`"${error}" is not an abort error code; Playwright takes ${Object.keys(ABORT_CODES).join(", ")}`,
				);
			await exchange.route.abort(error);
			close(exchange, {
				kind: "fault",
				direction: "none",
				source: "stub",
				meta: { reason: "abort", error },
			});
		},
	};

	/**
	 * A throwing stub is a bug in the test, as is an answer Playwright or
	 * Chromium would refuse, and a stream that cannot open is a setup
	 * problem. Either way answer 500 so the page sees an error instead of
	 * hanging, and say which rule failed — in the log AND in the body the app
	 * may display.
	 */
	const fail = async (exchange: Exchange, entry: Entry, error: unknown) => {
		report(exchange, entry, error);
		await exchange.route
			.fulfill({
				status: 500,
				headers: { "content-type": "text/plain; charset=utf-8" },
				body: failureBody(entry, error),
			})
			.catch((secondary: unknown) => {
				// The route took an answer before the failure, and Playwright
				// takes no other: the page waits for good.
				deps.log[levelOf(exchange)](
					"could not answer a failed rule: the request is left without an answer",
					{ rule: entry.rule.label, url: exchange.view.url.href },
					secondary,
				);
			});
	};

	const dispatch = async (
		attachment: AttachedContext,
		route: RoutePort,
		request: RequestPort,
	): Promise<void> => {
		const url = new URL(request.url());
		// Newest first. A snapshot: a rule added while this request is being
		// decided does not join its chain.
		const chain = entries.filter((entry) => wants(entry, url)).reverse();
		if (chain.length === 0) return route.fallback();
		const sender = senderOf(request);
		const exchange: Exchange = {
			view: await createView(request, attachment, url, sender.page),
			attachment,
			route,
			request,
			frame: sender.frame,
			recorded: new Map(),
			passed: [],
		};
		for (const entry of chain) {
			try {
				const outcome = await decide(entry, exchange);
				if (outcome === undefined) continue;
				if (outcome.type === "fallback") {
					exchange.passed.push(entry);
					continue;
				}
				// The table has an executor for every answer; the cast is only
				// because TypeScript cannot tie `outcome` to its own key.
				await (execute[outcome.type] as Executors[Answer["type"]])(
					outcome as never,
					exchange,
					entry,
				);
			} catch (error) {
				await fail(exchange, entry, error);
			}
			return;
		}
		track(exchange);
		await route.fallback();
	};

	const onRoute = async (
		attachment: AttachedContext,
		route: RoutePort,
		request: RequestPort,
	): Promise<void> => {
		try {
			await dispatch(attachment, route, request);
		} catch (error) {
			// Reading the request or handing it on failed: the page or context
			// closed under it. Never rejected to Playwright, where it would
			// surface as an unhandled rejection in whichever test runs next.
			const level = attachments.has(attachment) ? "warn" : "debug";
			deps.log[level]("request abandoned", { url: request.url() }, error);
		}
	};

	const ensureRoute = async (attachment: AttachedContext): Promise<void> => {
		let installing = routes.get(attachment);
		if (installing === undefined) {
			const installed: Installed = {
				predicate: (url) => entries.some((entry) => wants(entry, url)),
				handler: (route, request) => onRoute(attachment, route, request),
			};
			installing = attachment.context
				.route(installed.predicate, installed.handler)
				.then(() => installed);
			routes.set(attachment, installing);
			// A failed install must not be remembered as done.
			installing.catch(() => routes.delete(attachment));
		}
		await installing;
	};

	/** One observer failing must not starve the others, nor the timeline. */
	const notify = (entry: Entry, call: (rule: HttpRule) => void) => {
		try {
			call(entry.rule);
		} catch (error) {
			deps.log.error(
				"passthrough observer failed",
				{ rule: entry.rule.label },
				error,
			);
		}
	};

	/** Record the network's answer to a request a rule passed on. */
	const record = async (exchange: Exchange, request: RequestPort) => {
		try {
			const response = await request.response();
			if (response === null) return;
			const body = await response.body().then(
				(buffer) => toBytes(buffer),
				() => undefined,
			);
			const passthrough: PassthroughResponse = {
				status: response.status(),
				headers: response.headers(),
				body,
			};
			close(exchange, {
				kind: "response",
				direction: "in",
				source: "network",
				...(body === undefined ? {} : { data: body }),
				meta: { status: passthrough.status, headers: passthrough.headers },
			});
			for (const entry of exchange.passed)
				notify(entry, (rule) =>
					rule.onPassthroughResponse?.(passthrough, exchange.view),
				);
		} catch (error) {
			deps.log.warn(
				"could not read a passed-through response",
				{ url: exchange.view.url.href },
				error,
			);
		}
	};

	/** Whether a finished request was passed on, and its recording if so. */
	const onFinished = (request: RequestPort): Promise<void> | undefined => {
		const exchange = pending.get(request);
		if (exchange === undefined) return undefined;
		pending.delete(request);
		return record(exchange, request);
	};

	/**
	 * `reading`, as long as a read waits for it. Reading a body is a round
	 * trip to the page, which a dialog holds up until it closes: a read waits
	 * as long as a page is given to answer, then goes on, and the response
	 * reaches the timeline when its body does.
	 */
	const bounded = (reading: Promise<void>, url: string): Promise<void> => {
		const waiting = new AbortController();
		return Promise.race([
			reading,
			deps.clock.sleep(deps.timeoutMs, waiting.signal).then(
				() =>
					deps.log.warn(
						"a response did not hand over its body in time; reads go on without it until it does (is a dialog open?)",
						{ url, timeoutMs: deps.timeoutMs },
					),
				// The body came first.
				() => undefined,
			),
		]).finally(() => waiting.abort());
	};

	const onFailed = (request: RequestPort) => {
		const error = request.failure()?.errorText;
		// A live stream the page let go of before the browser could bring it.
		unclaimed.get(request)?.settle(networkFault(error));
		const exchange = pending.get(request);
		if (exchange === undefined) return;
		pending.delete(request);
		close(exchange, networkFault(error));
		for (const entry of exchange.passed)
			notify(entry, (rule) =>
				rule.onPassthroughFailure?.(error, exchange.view),
			);
	};

	return {
		async add(rule): Promise<HttpRuleHandle> {
			if (
				rule.times !== undefined &&
				(!Number.isInteger(rule.times) || rule.times < 1)
			)
				throw new WirestageError(
					"INVALID_ARGUMENT",
					`rule "${rule.label}": times must be a positive integer, got ${rule.times}`,
				);
			const methods =
				rule.method === undefined
					? undefined
					: new Set(
							(typeof rule.method === "string"
								? [rule.method]
								: rule.method
							).map((m) => m.toUpperCase()),
						);
			const entry: Entry = {
				rule,
				matchesUrl: compileUrlMatcher(rule.url),
				methods,
				remaining: rule.times,
				hits: 0,
				active: true,
			};
			entries.push(entry);
			try {
				await Promise.all([...attachments.keys()].map(ensureRoute));
			} catch (error) {
				// Half-installed is worse than not installed: the caller got an
				// error, so the rule must not answer anywhere.
				retire(entry);
				throw error;
			}
			return {
				get hits() {
					return entry.hits;
				},
				get active() {
					return entry.active;
				},
				async remove() {
					retire(entry);
				},
			};
		},
		async attach(attachment) {
			const own: Listeners = {
				finished: (request) => {
					if (request.resourceType() === "document") void noteDocument(request);
					const reading = onFinished(request);
					if (reading === undefined) return;
					const waiting = bounded(reading, request.url());
					settling.add(waiting);
					void waiting.then(() => settling.delete(waiting));
				},
				failed: onFailed,
			};
			attachments.set(attachment, own);
			attachment.context.on("requestfinished", own.finished);
			attachment.context.on("requestfailed", own.failed);
			// Routing turns the browser's HTTP cache off and puts every request
			// through Playwright, so a stage with no rules installs nothing.
			if (entries.length > 0) await ensureRoute(attachment);
		},
		async detach(attachment) {
			const own = attachments.get(attachment);
			if (own === undefined) return;
			attachments.delete(attachment);
			attachment.context.off("requestfinished", own.finished);
			attachment.context.off("requestfailed", own.failed);
			// Nothing brings these now, and each holds a place on a listener.
			for (const waiting of [...unclaimed.values()])
				if (waiting.attachment === attachment)
					waiting.settle(unreached("the context was detached first"));
			const installing = routes.get(attachment);
			routes.delete(attachment);
			if (installing === undefined) return;
			try {
				const { predicate, handler } = await installing;
				await attachment.context.unroute(predicate, handler);
			} catch (error) {
				// A context that closed first has no route left to remove.
				deps.log.debug("unroute failed", { context: attachment.id }, error);
			}
		},
		async settle() {
			await Promise.all([
				...settling,
				// A stream the stub ended or cut is on its way to the timeline.
				...[...serving]
					.filter((served) => served.closing)
					.map((served) => served.stream.closed),
			]);
		},
	};
}
