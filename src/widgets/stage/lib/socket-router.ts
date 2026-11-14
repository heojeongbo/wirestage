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

/**
 * A close as the server's end can carry it out. Playwright closes that end
 * with the browser's own `WebSocket.close(code, reason)`, which throws on a
 * code a script may not send, and on a reason without a code — and Playwright
 * swallows the error, which leaves the connection open for good. Such a close
 * goes out as a normal closure, 1000, with its reason: the close is the point.
 */
const forServer = (options: CloseOptions): CloseOptions => {
	const { code, reason } = options ?? {};
	if (code === undefined ? reason === undefined : sendable(code))
		return options;
	return { code: 1000, ...(reason === undefined ? {} : { reason }) };
};

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
		let server: SocketPeer | undefined;
		const view: SocketView = {
			correlation: deps.correlation(),
			url,
			context: attachment.id,
			page: peer(route),
			connectToServer: () => {
				server ??= peer(route.connectToServer(), forServer);
				return server;
			},
		};
		try {
			// Awaited: Playwright opens the page's end only once this handler
			// settles, so the rule is wired up before the first message.
			await entry.rule.open(view);
		} catch (error) {
			// Never rejected to Playwright, where it would surface as an
			// unhandled rejection in whichever test runs next.
			deps.log.error(
				"socket rule failed",
				{ rule: entry.rule.label, url: url.href },
				error,
			);
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
