import type { PluginContext } from "../../../entities/plugin/index.js";
import {
	createArrivals,
	createDeferred,
} from "../../../shared/lib/async/index.js";
import type { UrlMatcher } from "../../../shared/lib/match/index.js";
import type {
	WsCloseInfo,
	WsConnection,
	WsMessage,
	WsMock,
	WsMockOptions,
} from "../model/types.js";
import {
	broadcast,
	closedError,
	createSocketLog,
	encodeOutgoing,
	toMessage,
} from "./wire.js";

/** A fake server: every matching socket becomes a connection the test drives. */
export async function createMock(
	context: PluginContext,
	protocol: string,
	url: UrlMatcher,
	options: WsMockOptions,
): Promise<WsMock> {
	const connections = createArrivals<WsConnection>({
		clock: context.clock,
		label: "WebSocket connection",
	});
	const rule = await context.sockets.add({
		protocol,
		label: `mock ${String(url)}`,
		url,
		...(options.times === undefined ? {} : { times: options.times }),
		async open(socket) {
			const log = createSocketLog(context, protocol, socket);
			const messages = createArrivals<WsMessage>({
				clock: context.clock,
				label: `message on ${socket.url.pathname}`,
			});
			const closed = createDeferred<WsCloseInfo>();
			// The page hears of a close the stub starts through the same event
			// as its own; whoever asked first is who closed.
			let closedBy: "page" | "stub" = "page";
			log("lifecycle", "none", "page", { event: "open", url: socket.url.href });
			socket.page.onMessage((raw) => {
				messages.push(toMessage("out", raw, context.clock.now()));
				log("message", "out", "page", {}, raw);
			});
			socket.page.onClose((code, reason) => {
				// Once per connection: a close is reported again when the route
				// completes it, which the close below does.
				if (closed.settled) return;
				closed.resolve({ code, reason });
				log("lifecycle", "none", closedBy, { event: "close", code, reason });
				// A handler here turns off Playwright's own answer to the page's
				// close, and without one the page's socket would hang in CLOSING.
				if (closedBy === "page")
					void socket.page.close({
						...(code === undefined ? {} : { code }),
						...(reason === undefined ? {} : { reason }),
					});
			});
			// Over from the moment the stub closes it, before the page hears.
			const over = () => closed.settled || closedBy === "stub";
			const connection: WsConnection = {
				url: socket.url.href,
				get messages() {
					return messages.items;
				},
				get open() {
					return !over();
				},
				nextMessage: (waitOptions) => messages.next(waitOptions),
				send(data) {
					if (over()) throw closedError(socket.url.href);
					const encoded = encodeOutgoing(data);
					socket.page.send(encoded);
					log("message", "in", "stub", {}, encoded);
				},
				async close(closeOptions) {
					closedBy = "stub";
					await socket.page.close(closeOptions);
				},
				closed: closed.promise,
			};
			connections.push(connection);
			try {
				await options.onConnect?.(connection);
			} catch (error) {
				// The stage closes the socket of a rule that throws: the close
				// the page then hears of is the stub's doing.
				closedBy = "stub";
				throw error;
			}
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
		broadcast: (data) => broadcast(connections.items, data),
		remove: () => rule.remove(),
	};
}
