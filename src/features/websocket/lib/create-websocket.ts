import {
	definePlugin,
	type WirePlugin,
} from "../../../entities/plugin/index.js";
import type { WebSocketApi, WebSocketOptions } from "../model/types.js";
import { createMock } from "./mock.js";
import { createProxy } from "./proxy.js";

/**
 * WebSockets: fake servers driven from the test, and pass-through proxies
 * that record and can drop messages. Both are rules on the stage's socket
 * router, which owns the browser's side of it.
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
			};
			return { api };
		},
	});
}
