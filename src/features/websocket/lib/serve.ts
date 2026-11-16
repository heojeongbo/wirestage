import type {
	Direction,
	FrameInit,
	FrameKind,
	FrameSource,
	Timeline,
} from "../../../entities/frame/index.js";
import type {
	Ports,
	ServedUpgrade,
	UpgradeResponse,
} from "../../../shared/api/http-server/index.js";
import {
	type Arrivals,
	createArrivals,
	createDeferred,
} from "../../../shared/lib/async/index.js";
import { fitUtf8 } from "../../../shared/lib/bytes/index.js";
import type { Clock } from "../../../shared/lib/clock/index.js";
import { messageOf, WirestageError } from "../../../shared/lib/errors/index.js";
import type { ScopedLogger } from "../../../shared/lib/logger/index.js";
import {
	compileUrlMatcher,
	type UrlMatcher,
} from "../../../shared/lib/match/index.js";
import type {
	WsCloseInfo,
	WsMessage,
	WsServeOptions,
	WsServer,
	WsServerConnection,
	WsServerMock,
	WsServerMockOptions,
} from "../model/types.js";
import { broadcast, closedError, encodeOutgoing, toMessage } from "./wire.js";

export interface ServeDeps {
	/** The protocol the server's frames are recorded under. */
	readonly protocol: string;
	readonly timeline: Timeline;
	readonly clock: Clock;
	readonly log: ScopedLogger;
	readonly ports: Ports;
	readonly correlation: () => string;
	/** Told when the server closes, so the plugin can forget it. */
	readonly onClose: (server: WsServer) => void;
}

interface Rule {
	readonly label: string;
	readonly matches: (url: URL) => boolean;
	readonly onConnect: WsServerMockOptions["onConnect"];
	readonly connections: Arrivals<WsServerConnection>;
	remaining: number | undefined;
	hits: number;
	active: boolean;
}

const TEXT = { "content-type": "text/plain; charset=utf-8" };

/**
 * A served WebSocket fake: rules, newest first, as the page's are; every
 * connection on the timeline, the client's side as `network` and the
 * server's as `server`.
 */
export async function serveWebSocket(
	deps: ServeDeps,
	options: WsServeOptions,
): Promise<WsServer> {
	const name = options.name ?? `${deps.protocol} server`;
	/** Rules, oldest first. */
	const rules: Rule[] = [];
	/** Connections not over yet: closing the server cuts them. */
	const live = new Set<WsServerConnection>();
	let url = "";

	const record = (
		init: Omit<FrameInit, "protocol" | "meta"> & {
			readonly meta: Readonly<Record<string, unknown>>;
		},
	) =>
		deps.timeline.append({
			protocol: deps.protocol,
			...init,
			meta: { ...init.meta, server: url },
		});

	const retire = (rule: Rule) => {
		if (!rule.active) return;
		rule.active = false;
		rules.splice(rules.indexOf(rule), 1);
	};

	/** Accept the handshake for `rule`, and drive the connection it opens. */
	const take = async (
		rule: Rule,
		request: ServedUpgrade,
		response: UpgradeResponse,
	): Promise<void> => {
		const correlation = deps.correlation();
		const log = (
			kind: FrameKind,
			direction: Direction,
			source: FrameSource,
			meta: Readonly<Record<string, unknown>>,
			data?: string | Uint8Array,
		) =>
			record({
				kind,
				direction,
				endpoint: request.url.pathname,
				source,
				correlation,
				meta,
				...(data === undefined ? {} : { data }),
			});
		const messages = createArrivals<WsMessage>({
			clock: deps.clock,
			label: `message on ${request.url.pathname} to ${name}`,
		});
		const closed = createDeferred<WsCloseInfo>();
		let cut = false;
		const socket = response.accept((data) => {
			messages.push(toMessage("out", data, deps.clock.now()));
			log("message", "out", "network", {}, data);
		});
		log("lifecycle", "none", "network", {
			event: "open",
			url: request.url.href,
			headers: request.headers,
			protocol: socket.protocol,
		});
		const connection: WsServerConnection = {
			url: request.url.href,
			get messages() {
				return messages.items;
			},
			get open() {
				return socket.open;
			},
			nextMessage: (waitOptions) => messages.next(waitOptions),
			send(data) {
				if (!socket.open) throw closedError(request.url.href);
				const encoded = encodeOutgoing(data);
				socket.send(encoded);
				log("message", "in", "server", {}, encoded);
			},
			async close(closeOptions = {}) {
				await socket.close(closeOptions.code, closeOptions.reason);
			},
			cut() {
				if (cut || closed.settled) return;
				cut = true;
				log("fault", "none", "server", { reason: "cut" });
				socket.cut();
			},
			closed: closed.promise,
		};
		live.add(connection);
		void socket.closed.then((end) => {
			live.delete(connection);
			// A cut is on record as its fault.
			if (!cut)
				log("lifecycle", "none", end.by === "client" ? "network" : "server", {
					event: "close",
					code: end.code,
					reason: end.reason,
				});
			closed.resolve({ code: end.code, reason: end.reason });
		});
		rule.connections.push(connection);
		try {
			await rule.onConnect?.(connection);
		} catch (error) {
			// A bug in the test: say which rule, in the log, on the timeline and
			// in the reason the client is closed with.
			const message = messageOf(error);
			deps.log.error(
				"WebSocket rule failed",
				{ rule: rule.label, server: name },
				error,
			);
			log("fault", "none", "server", {
				reason: "rule-error",
				rule: rule.label,
				error: message,
			});
			await socket.close(
				1011,
				fitUtf8(`wirestage: rule "${rule.label}" failed: ${message}`, 123),
			);
		}
	};

	const listening = await deps.ports.listen(
		{
			name,
			...(options.host === undefined ? {} : { host: options.host }),
			...(options.port === undefined ? {} : { port: options.port }),
		},
		{
			websocket(request, response) {
				const rule = [...rules]
					.reverse()
					.find((each) => each.matches(request.url));
				if (rule === undefined) {
					record({
						kind: "fault",
						direction: "none",
						endpoint: request.url.pathname,
						source: "server",
						correlation: deps.correlation(),
						meta: { reason: "unmatched", url: request.url.href, status: 404 },
					});
					response.refuse(
						404,
						TEXT,
						`wirestage: ${name} has no WebSocket route for ${request.url.pathname}`,
					);
					return;
				}
				// Claimed before the rule runs: two handshakes at once cannot both
				// take its last turn.
				rule.hits += 1;
				if (rule.remaining !== undefined && --rule.remaining === 0)
					retire(rule);
				return take(rule, request, response);
			},
		},
	);
	url = listening.url.replace(/^http/, "ws");

	let closing: Promise<void> | undefined;
	const server: WsServer = {
		url,
		port: listening.port,
		async mock(matcher: UrlMatcher, mockOptions = {}): Promise<WsServerMock> {
			const label = `mock ${String(matcher)}`;
			if (
				mockOptions.times !== undefined &&
				(!Number.isInteger(mockOptions.times) || mockOptions.times < 1)
			)
				throw new WirestageError(
					"INVALID_ARGUMENT",
					`rule "${label}": times must be a positive integer, got ${mockOptions.times}`,
				);
			const rule: Rule = {
				label,
				matches: compileUrlMatcher(matcher),
				onConnect: mockOptions.onConnect,
				connections: createArrivals<WsServerConnection>({
					clock: deps.clock,
					label: `WebSocket connection to ${name}`,
				}),
				remaining: mockOptions.times,
				hits: 0,
				active: true,
			};
			rules.push(rule);
			return {
				get hits() {
					return rule.hits;
				},
				get connections() {
					return rule.connections.items;
				},
				next: (waitOptions) => rule.connections.next(waitOptions),
				broadcast: (data) => broadcast(rule.connections.items, data),
				async remove() {
					retire(rule);
				},
			};
		},
		async frames(filter = {}) {
			return deps.timeline.frames({
				protocol: deps.protocol,
				...(filter.endpoint === undefined ? {} : { endpoint: filter.endpoint }),
				where: (frame) => frame.meta["server"] === url,
			});
		},
		close() {
			closing ??= (async () => {
				for (const rule of [...rules]) retire(rule);
				for (const connection of [...live]) connection.cut();
				deps.onClose(server);
				await listening.close();
			})();
			return closing;
		},
	};
	return server;
}
