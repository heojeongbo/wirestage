import {
	definePlugin,
	type WirePlugin,
} from "../../../entities/plugin/index.js";
import { createSequence } from "../../../shared/lib/id/index.js";
import type {
	WebSocketApi,
	WebSocketOptions,
	WsServer,
} from "../model/types.js";
import { createMock } from "./mock.js";
import { createProxy } from "./proxy.js";
import { serveWebSocket } from "./serve.js";

/**
 * WebSockets: fake servers driven from the test, and pass-through proxies
 * that record and can drop messages. Both are rules on the stage's socket
 * router, which owns the browser's side of it. `serve()` puts a fake on a
 * port of its own, for clients outside the browser.
 */
export function websocket(
	options: WebSocketOptions = {},
): WirePlugin<"websocket", WebSocketApi> {
	return definePlugin({
		name: "websocket",
		scope: "Ws",
		setup(context) {
			const { name } = context;
			if (!options.lazy) context.sockets.prepare();
			const servers = new Set<WsServer>();
			// Under the plugin's own name: two instances never share an id.
			const servedCorrelation = createSequence(`${name}-`);
			const api: WebSocketApi = {
				mock: (url, mockOptions = {}) =>
					createMock(context, name, url, mockOptions),
				proxy: (url, proxyOptions = {}) =>
					createProxy(context, name, url, proxyOptions),
				async frames(filter = {}) {
					await context.sync();
					return context.timeline.frames({
						protocol: name,
						...(filter.endpoint === undefined
							? {}
							: { endpoint: filter.endpoint }),
					});
				},
				async serve(serveOptions = {}) {
					const server = await serveWebSocket(
						{
							protocol: name,
							timeline: context.timeline,
							clock: context.clock,
							log: context.log,
							ports: context.ports,
							correlation: servedCorrelation,
							onClose: (closed) => servers.delete(closed),
						},
						serveOptions,
					);
					servers.add(server);
					return server;
				},
			};
			return {
				api,
				async dispose() {
					await Promise.all([...servers].map((server) => server.close()));
				},
			};
		},
	});
}
