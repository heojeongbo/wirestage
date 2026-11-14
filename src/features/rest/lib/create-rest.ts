import {
	definePlugin,
	type HttpOutcome,
	type HttpRequestView,
	type WirePlugin,
} from "../../../entities/plugin/index.js";
import { createArrivals } from "../../../shared/lib/async/index.js";
import { createSequence } from "../../../shared/lib/id/index.js";
import type {
	RestApi,
	RestMethod,
	RestOptions,
	RestReply,
	RestRequest,
	RestServer,
} from "../model/types.js";
import { filterCalls } from "./calls.js";
import { compilePath } from "./path.js";
import { serveRest } from "./serve.js";

/**
 * REST and other plain HTTP: routes by method and path with `:params`, replies
 * built from small helpers, faults, and recording of the real responses.
 */
export function rest(options: RestOptions = {}): WirePlugin<"rest", RestApi> {
	return definePlugin({
		name: "rest",
		scope: "Rest",
		setup(context) {
			const { name } = context;
			/** The record rule being added, once: every context gets it. */
			let recording: Promise<unknown> | undefined;
			const servers = new Set<RestServer>();
			// Under the plugin's own name: two instances never share an id.
			const servedCorrelation = createSequence(`${name}-`);

			const toOutcome = async (reply: RestReply): Promise<HttpOutcome> => {
				switch (reply.kind) {
					case "response":
						return {
							type: "fulfill",
							status: reply.status,
							headers: reply.headers,
							...(reply.body === undefined ? {} : { body: reply.body }),
						};
					case "passthrough":
						return { type: "fallback" };
					case "abort":
						return { type: "abort", error: reply.error };
					case "delay":
						await context.clock.sleep(reply.ms);
						return toOutcome(reply.reply);
				}
			};

			const on: RestApi["on"] = async (
				method,
				path,
				resolver,
				routeOptions = {},
			) => {
				const matcher = compilePath(path, options.baseURL);
				// Own, enumerable fields: a request spreads and prints whole.
				const toRequest = (view: HttpRequestView): RestRequest => ({
					get correlation() {
						return view.correlation;
					},
					method: view.method,
					url: view.url,
					headers: view.headers,
					page: view.page,
					context: view.context,
					resourceType: view.resourceType,
					body: view.body,
					text: view.text,
					json: view.json,
					// The rule's URL predicate is this matcher, so it matched.
					params: matcher.match(view.url) as Record<string, string>,
					query: view.url.searchParams,
				});
				const label = `${method} ${String(path)}`;
				const requests = createArrivals<RestRequest>({
					clock: context.clock,
					label: `${label} request`,
				});
				const { match } = routeOptions;
				const rule = await context.http.add({
					protocol: name,
					label,
					url: (url) => matcher.match(url) !== undefined,
					...(method === "*" ? {} : { method }),
					...(routeOptions.times === undefined
						? {}
						: { times: routeOptions.times }),
					...(match === undefined
						? {}
						: { match: (view) => match(toRequest(view)) }),
					handle: async (view) => {
						const request = toRequest(view);
						requests.push(request);
						return toOutcome(
							typeof resolver === "function"
								? await resolver(request)
								: resolver,
						);
					},
				});
				return {
					get hits() {
						return rule.hits;
					},
					get requests() {
						return requests.items;
					},
					next: (waitOptions) => requests.next(waitOptions),
					remove: () => rule.remove(),
				};
			};

			const verb =
				(method: RestMethod): RestApi["get"] =>
				(path, resolver, routeOptions) =>
					on(method, path, resolver, routeOptions);

			const api: RestApi = {
				on,
				get: verb("GET"),
				post: verb("POST"),
				put: verb("PUT"),
				patch: verb("PATCH"),
				delete: verb("DELETE"),
				async calls(filter = {}) {
					await context.sync();
					return filterCalls(
						context.timeline.frames({ protocol: name }),
						filter,
						options.baseURL,
					);
				},
				async serve(serveOptions = {}) {
					const server = await serveRest(
						{
							protocol: name,
							timeline: context.timeline,
							clock: context.clock,
							log: context.log,
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
				async attach() {
					if (options.record === undefined || options.record === false) return;
					const base = compilePath(`${options.baseURL ?? ""}/**`, undefined);
					recording ??= context.http
						.add({
							protocol: name,
							label: "record",
							url:
								options.record === true
									? (url) => base.match(url) !== undefined
									: options.record,
							handle: () => ({ type: "fallback" }),
						})
						.catch((error: unknown) => {
							// The router took the rule back: the next attach adds it again.
							recording = undefined;
							throw error;
						});
					await recording;
				},
			};
		},
	});
}
