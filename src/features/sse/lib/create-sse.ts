import {
	definePlugin,
	type WirePlugin,
} from "../../../entities/plugin/index.js";
import {
	type Arrivals,
	createArrivals,
} from "../../../shared/lib/async/index.js";
import type { SseApi, SseConnection, SseEvent } from "../model/types.js";
import { encodeSseEvent } from "./encode.js";

/**
 * Server-sent events: answer an EventSource (or a fetch reading an event
 * stream) with a response the test writes one event at a time, with clean
 * ends and cuts that exercise the client's reconnect.
 */
export function sse(): WirePlugin<"sse", SseApi> {
	return definePlugin({
		name: "sse",
		scope: "Sse",
		setup(context) {
			const { name } = context;
			const api: SseApi = {
				async stream(url, streamOptions = {}) {
					/** Requests the stub answered: each should become a connection. */
					let taken = 0;
					const connections: Arrivals<SseConnection> = createArrivals({
						clock: context.clock,
						label: "SSE connection",
						// The stub answered, yet no connection came of it: the
						// redirect to the stream server is what went missing.
						hint: (): string | undefined =>
							taken > connections.items.length
								? `${taken - connections.items.length} request(s) matched but never reached the local stream server — see "Live streams" in docs/troubleshooting.md`
								: undefined,
					});
					const rule = await context.http.add({
						protocol: name,
						label: `sse ${String(url)}`,
						url,
						...(streamOptions.times === undefined
							? {}
							: { times: streamOptions.times }),
						...(streamOptions.match === undefined
							? {}
							: { match: streamOptions.match }),
						handle(view) {
							taken += 1;
							return {
								type: "stream",
								open(stream) {
									stream.head(streamOptions.status ?? 200, {
										"content-type": "text/event-stream; charset=utf-8",
										"cache-control": "no-cache",
										connection: "keep-alive",
										...streamOptions.headers,
									});
									// An EventSource opens on the headers, before any event.
									stream.flush();
									let sent = 0;
									const connection: SseConnection = {
										request: view,
										lastEventId: stream.requestHeaders["last-event-id"],
										get sent() {
											return sent;
										},
										async send(event: SseEvent | string) {
											const chunk = encodeSseEvent(event);
											await stream.write(chunk);
											sent += 1;
											context.timeline.append({
												protocol: name,
												kind: "event",
												direction: "in",
												endpoint: view.url.pathname,
												source: "stub",
												data: chunk,
												value: event,
												correlation: view.correlation,
												context: view.context,
												...(view.page === undefined ? {} : { page: view.page }),
											});
										},
										end: () => stream.end(),
										async cut() {
											stream.cut();
										},
										closed: stream.closed,
									};
									if (streamOptions.retry !== undefined)
										void stream
											.write(`retry: ${streamOptions.retry}\n\n`)
											.catch(() => {});
									connections.push(connection);
								},
							};
						},
					});
					return {
						get hits() {
							return rule.hits;
						},
						next: (waitOptions) => connections.next(waitOptions),
						get connections() {
							return connections.items;
						},
						async broadcast(event) {
							for (const connection of connections.items)
								await connection.send(event).catch(() => {});
						},
						remove: () => rule.remove(),
					};
				},
				async events(filter = {}) {
					await context.sync();
					return context.timeline.frames({
						protocol: name,
						kind: "event",
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
