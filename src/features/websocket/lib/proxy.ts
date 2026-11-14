import type {
	PluginContext,
	SocketPeer,
} from "../../../entities/plugin/index.js";
import {
	createArrivals,
	createDeferred,
} from "../../../shared/lib/async/index.js";
import type { UrlMatcher } from "../../../shared/lib/match/index.js";
import type {
	WsCloseInfo,
	WsMessage,
	WsProxy,
	WsProxyConnection,
	WsProxyOptions,
} from "../model/types.js";
import {
	closedError,
	createSocketLog,
	encodeOutgoing,
	toMessage,
} from "./wire.js";

/**
 * A pass-through to the real server that records both directions and can
 * drop or inject messages on the way.
 */
export async function createProxy(
	context: PluginContext,
	protocol: string,
	url: UrlMatcher,
	options: WsProxyOptions,
): Promise<WsProxy> {
	const connections = createArrivals<WsProxyConnection>({
		clock: context.clock,
		label: "WebSocket connection",
	});
	const rule = await context.sockets.add({
		protocol,
		label: `proxy ${String(url)}`,
		url,
		...(options.times === undefined ? {} : { times: options.times }),
		open(socket) {
			const log = createSocketLog(context, protocol, socket);
			const page = socket.page;
			const server = socket.connectToServer();
			const messages = createArrivals<WsMessage>({
				clock: context.clock,
				label: `message on ${socket.url.pathname}`,
			});
			const closed = createDeferred<WsCloseInfo>();
			// Who closed, when neither end did: the test, or the stub — the
			// stage closes the socket of a rule that throws.
			let closedBy: "test" | "stub" | undefined;
			log("lifecycle", "none", "page", { event: "open", url: socket.url.href });
			const forward = (
				direction: "in" | "out",
				raw: string | Uint8Array,
				to: SocketPeer,
			) => {
				const passing = toMessage(direction, raw, context.clock.now());
				messages.push(passing);
				let dropped: boolean | undefined;
				try {
					dropped = options.drop?.(passing);
				} catch (error) {
					// The stage fails a rule that throws and closes both ends: the
					// closes they report are the stub's, not the page's or server's.
					closedBy ??= "stub";
					throw error;
				}
				if (dropped) {
					log("fault", direction, "stub", { reason: "dropped" }, raw);
					return;
				}
				log(
					"message",
					direction,
					direction === "out" ? "page" : "network",
					{},
					raw,
				);
				to.send(raw);
			};
			page.onMessage((raw) => forward("out", raw, server));
			server.onMessage((raw) => forward("in", raw, page));
			// A close handler turns off Playwright's own forwarding of the close,
			// so whichever end closes first, both are closed by hand: the other
			// end to pass the close on, and the end that started it to complete
			// it — the page's socket hangs in CLOSING until its end is closed.
			// Once: each of those closes is reported back through a handler.
			const relay =
				(from: "page" | "network") =>
				(code: number | undefined, reason: string | undefined) => {
					if (closed.settled) return;
					closed.resolve({ code, reason });
					log("lifecycle", "none", closedBy ?? from, {
						event: "close",
						code,
						reason,
					});
					const passed = {
						...(code === undefined ? {} : { code }),
						...(reason === undefined ? {} : { reason }),
					};
					void page.close(passed);
					void server.close(passed);
				};
			page.onClose(relay("page"));
			server.onClose(relay("network"));
			// Over from the moment the test closes it or the rule fails, before
			// either end hears.
			const over = () => closed.settled || closedBy !== undefined;
			connections.push({
				url: socket.url.href,
				get messages() {
					return messages.items;
				},
				nextMessage: (waitOptions) => messages.next(waitOptions),
				toPage(data) {
					if (over()) throw closedError(socket);
					const encoded = encodeOutgoing(data);
					page.send(encoded);
					log("message", "in", "test", { injected: true }, encoded);
				},
				toServer(data) {
					if (over()) throw closedError(socket);
					const encoded = encodeOutgoing(data);
					server.send(encoded);
					log("message", "out", "test", { injected: true }, encoded);
				},
				async close(closeOptions) {
					closedBy = "test";
					await Promise.all([
						page.close(closeOptions),
						server.close(closeOptions),
					]);
				},
				closed: closed.promise,
			});
		},
	});
	return {
		get hits() {
			return rule.hits;
		},
		get connections() {
			return connections.items;
		},
		next: (waitOptions) => connections.next(waitOptions),
		remove: () => rule.remove(),
	};
}
