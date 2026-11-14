import type { FrameInit, Timeline } from "../../../entities/frame/index.js";
import type {
	HttpOutcome,
	HttpRequestView,
	HttpRouter,
	HttpRule,
	HttpRuleHandle,
	PassthroughResponse,
} from "../../../entities/plugin/index.js";
import type {
	PagePort,
	RequestPort,
	RouteHandler,
	RoutePort,
	UrlPredicate,
} from "../../../shared/api/playwright/index.js";
import type { StreamServer } from "../../../shared/api/stream-server/index.js";
import { toBuffer, toBytes, utf8 } from "../../../shared/lib/bytes/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type { ScopedLogger } from "../../../shared/lib/logger/index.js";
import { compileUrlMatcher } from "../../../shared/lib/match/index.js";
import type { AttachedContext } from "./attached-context.js";
import { createResponseStream } from "./response-stream.js";

export interface HttpRouterDeps {
	readonly timeline: Timeline;
	readonly log: ScopedLogger;
	readonly streams: Pick<StreamServer, "open">;
	readonly pageId: (page: PagePort) => string;
	readonly correlation: () => string;
}

export interface HttpRouterEngine extends HttpRouter {
	attach(attachment: AttachedContext): Promise<void>;
	detach(attachment: AttachedContext): Promise<void>;
	/**
	 * Wait for the responses that already came back to be on the timeline:
	 * reading a passed-through response takes a round trip to the browser.
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

/**
 * One request, as every rule that sees it shares it: one view, one
 * correlation id, one raw request frame per protocol.
 */
interface Exchange {
	readonly view: HttpRequestView;
	readonly attachment: AttachedContext;
	readonly route: RoutePort;
	readonly request: RequestPort;
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
 */
type Executors = {
	readonly [Type in Answer["type"]]: (
		outcome: Extract<Answer, { readonly type: Type }>,
		exchange: Exchange,
		entry: Entry,
	) => Promise<void>;
};

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
	const localNetwork = new WeakMap<AttachedContext, Promise<void>>();
	/** Responses being read off the browser, on their way to the timeline. */
	const settling = new Set<Promise<void>>();

	/**
	 * Chromium's Local Network Access blocks a page whose address space it
	 * cannot place — every page a route fulfilled, and any remote origin — from
	 * reaching the loopback stream server. Granted once per context, the first
	 * time a stream needs it, and every stream waits for that one grant; a
	 * browser without the permission simply refuses it, and then needs none.
	 */
	const allowLocalNetwork = (attachment: AttachedContext): Promise<void> => {
		let granting = localNetwork.get(attachment);
		if (granting === undefined) {
			granting = Promise.resolve()
				.then(() =>
					attachment.context.grantPermissions?.(["local-network-access"]),
				)
				.catch((error: unknown) => {
					deps.log.debug("local-network-access not granted", {}, error);
				});
			localNetwork.set(attachment, granting);
		}
		return granting;
	};

	const createView = async (
		request: RequestPort,
		attachment: AttachedContext,
		url: URL,
	): Promise<HttpRequestView> => {
		let body: Uint8Array | undefined;
		let correlation: string | undefined;
		const getBody = () => {
			body ??= toBytes(request.postDataBuffer() ?? new Uint8Array(0));
			return body;
		};
		let page: string | undefined;
		try {
			page = deps.pageId(request.frame().page());
		} catch {
			// Service-worker requests have no frame.
			page = undefined;
		}
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

	const execute: Executors = {
		async fulfill(outcome, exchange) {
			const status = outcome.status ?? 200;
			const headers = { ...outcome.headers };
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
		async stream(outcome, exchange) {
			const session = await deps.streams.open(
				(request, response) => {
					const stream = createResponseStream(request, response);
					void stream.closed.then((end) =>
						close(
							exchange,
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
									},
						),
					);
					return outcome.open(stream);
				},
				{ secure: exchange.view.url.protocol === "https:" },
			);
			await allowLocalNetwork(exchange.attachment);
			try {
				await exchange.route.continue({ url: session.url });
			} catch (error) {
				session.dispose();
				throw error;
			}
		},
		async continue(outcome, exchange, entry) {
			exchange.passed.push(entry);
			track(exchange);
			await exchange.route.continue({
				...(outcome.url === undefined ? {} : { url: outcome.url }),
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
	 * A throwing stub is a bug in the test, and a stream that cannot open is a
	 * setup problem. Either way answer 500 so the page sees an error instead of
	 * hanging, and say which rule failed — in the log AND in the body the app
	 * may display.
	 */
	const fail = async (exchange: Exchange, entry: Entry, error: unknown) => {
		const { rule } = entry;
		const message = error instanceof Error ? error.message : String(error);
		// A request that outlived its context fails for that reason alone.
		const level = attachments.has(exchange.attachment) ? "error" : "debug";
		deps.log[level](
			"rule failed",
			{ rule: rule.label, url: exchange.view.url.href },
			error,
		);
		append(exchange, rule.protocol, nameOf(entry, exchange.view), {
			kind: "fault",
			direction: "none",
			source: "stub",
			meta: { reason: "rule-error", error: message },
		});
		await exchange.route
			.fulfill({
				status: 500,
				headers: { "content-type": "text/plain; charset=utf-8" },
				body: `wirestage: rule "${rule.label}" failed: ${message}`,
			})
			.catch((secondary: unknown) => {
				// The route was already answered before the failure.
				deps.log.debug("could not answer a failed rule", {}, secondary);
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
		const exchange: Exchange = {
			view: await createView(request, attachment, url),
			attachment,
			route,
			request,
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

	const onFinished = async (request: RequestPort) => {
		const exchange = pending.get(request);
		if (exchange === undefined) return;
		pending.delete(request);
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

	const onFailed = (request: RequestPort) => {
		const exchange = pending.get(request);
		if (exchange === undefined) return;
		pending.delete(request);
		const error = request.failure()?.errorText;
		close(exchange, {
			kind: "fault",
			direction: "none",
			source: "network",
			meta: { reason: "network", error },
		});
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
					const reading = onFinished(request).finally(() =>
						settling.delete(reading),
					);
					settling.add(reading);
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
			await Promise.all(settling);
		},
	};
}
