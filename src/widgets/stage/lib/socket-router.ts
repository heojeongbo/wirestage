import type { Timeline } from "../../../entities/frame/index.js";
import type {
	SocketPeer,
	SocketRouter,
	SocketRule,
	SocketRuleHandle,
	SocketView,
} from "../../../entities/plugin/index.js";
import type { WebSocketRoutePort } from "../../../shared/api/playwright/index.js";
import { toBuffer } from "../../../shared/lib/bytes/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type { ScopedLogger } from "../../../shared/lib/logger/index.js";
import { compileUrlMatcher } from "../../../shared/lib/match/index.js";
import type { AttachedContext } from "./attached-context.js";

export interface SocketRouterDeps {
	readonly timeline: Timeline;
	readonly log: ScopedLogger;
	readonly correlation: () => string;
}

export interface SocketRouterEngine extends SocketRouter {
	attach(attachment: AttachedContext): Promise<void>;
	detach(attachment: AttachedContext): void;
}

interface Entry {
	readonly rule: SocketRule;
	readonly matchesUrl: (url: URL) => boolean;
	remaining: number | undefined;
	hits: number;
	active: boolean;
}

type CloseOptions = Parameters<SocketPeer["close"]>[0];

/** What a script may pass to `WebSocket.close()`: 1000, or 3000-4999. */
const sendable = (code: number): boolean =>
	code === 1000 || (code >= 3000 && code <= 4999);

const encoder = new TextEncoder();

/**
 * A close reason cut to what a close frame carries: 123 bytes of UTF-8 (the
 * frame's 125, less the code), ending on a whole character.
 */
const fitReason = (reason: string): string =>
	// `encodeInto` stops before the first character that does not fit whole.
	reason.slice(0, encoder.encodeInto(reason, new Uint8Array(123)).read);

/**
 * A close as the server's end can carry it out. Playwright closes that end
 * with the browser's own `WebSocket.close(code, reason)`, which throws on a
 * code a script may not send, on a reason without a code and on a reason
 * over 123 bytes — and Playwright swallows the error, which leaves the
 * connection open for good. Such a close goes out as a normal closure, 1000,
 * with its reason cut to fit: the close is the point.
 */
const forServer = (options: CloseOptions): CloseOptions => {
	const { code, reason } = options ?? {};
	if (code === undefined && reason === undefined) return options;
	return {
		code: code !== undefined && sendable(code) ? code : 1000,
		...(reason === undefined ? {} : { reason: fitReason(reason) }),
	};
};

/** The message handler of an end whose messages the rule does not take. */
const drop = (): void => {};

/**
 * Turns WebSocket rules into ONE Playwright WebSocket route per attached
 * context, whose predicate asks the live rule list.
 *
 * One route, because Playwright cannot take a WebSocket route out again: a
 * removed rule, or a detached context, simply stops matching, which sends the
 * socket to the real server. And not before it is needed, because routing
 * replaces `WebSocket` in every document of the context — the first rule
 * installs it, or `prepare()` does at attach.
 */
export function createSocketRouter(deps: SocketRouterDeps): SocketRouterEngine {
	/** Active rules, oldest first. */
	const entries: Entry[] = [];
	const attachments = new Set<AttachedContext>();
	const routes = new Map<AttachedContext, Promise<void>>();
	let prepared = false;

	/** The newest rule that wants a socket to `url`. */
	const taker = (url: URL): Entry | undefined =>
		entries.findLast((entry) => {
			try {
				return entry.matchesUrl(url);
			} catch (error) {
				// The caller's predicate; one that throws must not break every
				// socket of the context.
				deps.log.error(
					"rule's URL matcher failed",
					{ rule: entry.rule.label, url: url.href },
					error,
				);
				return false;
			}
		});

	const retire = (entry: Entry) => {
		if (!entry.active) return;
		entry.active = false;
		entries.splice(entries.indexOf(entry), 1);
	};

	const peer = (
		route: WebSocketRoutePort,
		close: (options: CloseOptions) => CloseOptions = (options) => options,
	): SocketPeer => ({
		send: (data) =>
			route.send(typeof data === "string" ? data : toBuffer(data)),
		close: (options) => route.close(close(options)),
		onMessage: (handler) => route.onMessage(handler),
		onClose: (handler) => route.onClose(handler),
	});

	/**
	 * A rule that throws is a bug in the test. Say which rule failed — in the
	 * log, on the timeline, and in the reason the page's socket closes with —
	 * and close both ends: the page's socket would otherwise sit open with
	 * nobody answering it, and a server the rule connected would stay
	 * connected. 1011 is a server's "internal error"; the server's end gets
	 * 1000, as a script may not send 1011.
	 */
	const fail = async (
		rule: SocketRule,
		view: SocketView,
		server: SocketPeer | undefined,
		error: unknown,
	): Promise<void> => {
		const message = error instanceof Error ? error.message : String(error);
		deps.log.error(
			"socket rule failed",
			{ rule: rule.label, url: view.url.href },
			error,
		);
		deps.timeline.append({
			protocol: rule.protocol,
			kind: "fault",
			direction: "none",
			endpoint: view.url.pathname,
			source: "stub",
			correlation: view.correlation,
			context: view.context,
			meta: { reason: "rule-error", rule: rule.label, error: message },
		});
		const closing = {
			code: 1011,
			// Cut like the server's end, though the page's would take it whole:
			// no real server could send the page a longer one.
			reason: fitReason(`wirestage: rule "${rule.label}" failed: ${message}`),
		};
		await Promise.all([view.page.close(closing), server?.close(closing)]);
	};

	const onSocket = async (
		attachment: AttachedContext,
		route: WebSocketRoutePort,
	): Promise<void> => {
		const url = new URL(route.url());
		const entry = attachments.has(attachment) ? taker(url) : undefined;
		// The rule went, or the context was detached, between Playwright's
		// check and this call: the socket is the real server's.
		if (entry === undefined) {
			route.connectToServer();
			return;
		}
		entry.hits += 1;
		if (entry.remaining !== undefined && --entry.remaining === 0) retire(entry);
		// Playwright passes the messages of an end with no handler on to the
		// other end, unrecorded: a rule that wires one direction would leak
		// the other. So each end starts with a handler that drops them, which
		// the rule's own replaces.
		route.onMessage(drop);
		let server: SocketPeer | undefined;
		const view: SocketView = {
			correlation: deps.correlation(),
			url,
			context: attachment.id,
			page: peer(route),
			connectToServer: () => {
				if (server === undefined) {
					const upstream = route.connectToServer();
					upstream.onMessage(drop);
					server = peer(upstream, forServer);
				}
				return server;
			},
		};
		try {
			// Awaited: Playwright opens the page's end of a socket the rule
			// did not connect once this handler settles, so an async rule is
			// wired up before the first message.
			await entry.rule.open(view);
		} catch (error) {
			// Never rejected to Playwright, where it would surface as an
			// unhandled rejection in whichever test runs next.
			await fail(entry.rule, view, server, error);
		}
	};

	const ensureRoute = (attachment: AttachedContext): Promise<void> => {
		let installing = routes.get(attachment);
		if (installing === undefined) {
			installing = attachment.context.routeWebSocket(
				(url) => attachments.has(attachment) && taker(url) !== undefined,
				(route) => onSocket(attachment, route),
			);
			routes.set(attachment, installing);
			// A failed install must not be remembered as done.
			installing.catch(() => routes.delete(attachment));
		}
		return installing;
	};

	return {
		async add(rule): Promise<SocketRuleHandle> {
			if (
				rule.times !== undefined &&
				(!Number.isInteger(rule.times) || rule.times < 1)
			)
				throw new WirestageError(
					"INVALID_ARGUMENT",
					`rule "${rule.label}": times must be a positive integer, got ${rule.times}`,
				);
			const entry: Entry = {
				rule,
				matchesUrl: compileUrlMatcher(rule.url),
				remaining: rule.times,
				hits: 0,
				active: true,
			};
			entries.push(entry);
			try {
				await Promise.all([...attachments].map(ensureRoute));
			} catch (error) {
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
		prepare() {
			prepared = true;
		},
		async attach(attachment) {
			attachments.add(attachment);
			if (prepared || entries.length > 0) await ensureRoute(attachment);
		},
		detach(attachment) {
			attachments.delete(attachment);
			// The route stays in the browser; a context attached again gets a
			// new one, and this one's predicate never matches again.
			routes.delete(attachment);
		},
	};
}
