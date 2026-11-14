import type { FrameInit, Timeline } from "../../../entities/frame/index.js";
import {
	type ServedRequest,
	type ServedResponse,
	serveHttp,
} from "../../../shared/api/http-server/index.js";
import {
	type Arrivals,
	createArrivals,
} from "../../../shared/lib/async/index.js";
import type { Clock } from "../../../shared/lib/clock/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type { ScopedLogger } from "../../../shared/lib/logger/index.js";
import type {
	RestApi,
	RestMethod,
	RestReply,
	RestRequest,
	RestResolver,
	RestServeOptions,
	RestServer,
} from "../model/types.js";
import { filterCalls } from "./calls.js";
import { compilePath, type PathMatcher } from "./path.js";

export interface ServeDeps {
	/** The protocol the server's frames are recorded under. */
	readonly protocol: string;
	readonly timeline: Timeline;
	readonly clock: Clock;
	readonly log: ScopedLogger;
	readonly correlation: () => string;
	/** Told when the server closes, so the plugin can forget it. */
	readonly onClose: (server: RestServer) => void;
}

interface Route {
	readonly label: string;
	readonly method: string | undefined;
	readonly matcher: PathMatcher;
	readonly resolver: RestResolver;
	readonly match: ((request: RestRequest) => boolean) | undefined;
	readonly requests: Arrivals<RestRequest>;
	remaining: number | undefined;
	hits: number;
	active: boolean;
}

const TEXT = { "content-type": "text/plain; charset=utf-8" };

const failureOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** A served request as a route sees it, with that route's params. */
function restRequest(
	request: ServedRequest,
	correlation: string,
	params: Record<string, string>,
): RestRequest {
	const text = () => new TextDecoder().decode(request.body);
	return {
		correlation,
		method: request.method,
		url: request.url,
		headers: request.headers,
		page: undefined,
		context: "",
		resourceType: "other",
		body: () => request.body,
		text,
		json: <T>() => JSON.parse(text()) as T,
		params,
		query: request.url.searchParams,
	};
}

/**
 * A served fake: routes, newest first, as the browser's are; every exchange
 * on the timeline, the client's request as `network` and the answer as
 * `server`.
 */
export async function serveRest(
	deps: ServeDeps,
	options: RestServeOptions,
): Promise<RestServer> {
	const name = options.name ?? `${deps.protocol} server`;
	/** Routes, oldest first. */
	const routes: Route[] = [];
	let url = "";

	const record = (
		init: Omit<FrameInit, "protocol" | "endpoint">,
		path: string,
	) =>
		deps.timeline.append({
			protocol: deps.protocol,
			endpoint: path,
			...init,
			meta: { ...init.meta, server: url },
		});

	const retire = (route: Route) => {
		if (!route.active) return;
		route.active = false;
		routes.splice(routes.indexOf(route), 1);
	};

	/** Carry a reply out; `undefined` when it passes the request on. */
	const answer = async (
		reply: RestReply,
		response: ServedResponse,
		path: string,
		correlation: string,
	): Promise<"answered" | undefined> => {
		switch (reply.kind) {
			case "response": {
				const body = reply.body ?? "";
				// Recorded before it is sent: a client that reads its answer and
				// asks for `calls()` at once must find it there.
				record(
					{
						kind: "response",
						direction: "in",
						source: "server",
						data: body,
						meta: { status: reply.status, headers: reply.headers },
						correlation,
					},
					path,
				);
				await response.send(reply.status, reply.headers, body);
				return "answered";
			}
			case "passthrough":
				return undefined;
			case "abort":
				record(
					{
						kind: "fault",
						direction: "none",
						source: "server",
						meta: { reason: "abort", error: reply.error },
						correlation,
					},
					path,
				);
				response.reset();
				return "answered";
			case "delay":
				await deps.clock.sleep(reply.ms);
				return answer(reply.reply, response, path, correlation);
		}
	};

	/** A route's bug: logged, on the timeline, and the client gets a 500 saying so. */
	const fail = async (
		route: Route,
		error: unknown,
		response: ServedResponse,
		path: string,
		correlation: string,
	) => {
		deps.log.error("rule failed", { rule: route.label, server: name }, error);
		record(
			{
				kind: "fault",
				direction: "none",
				source: "server",
				meta: {
					reason: "rule-error",
					rule: route.label,
					error: failureOf(error),
				},
				correlation,
			},
			path,
		);
		await response.send(
			500,
			TEXT,
			`wirestage: rule "${route.label}" failed: ${failureOf(error)}`,
		);
	};

	const handle = async (request: ServedRequest, response: ServedResponse) => {
		const correlation = deps.correlation();
		const path = request.url.pathname;
		record(
			{
				kind: "request",
				direction: "out",
				source: "network",
				data: request.body,
				meta: {
					method: request.method,
					url: request.url.href,
					headers: request.headers,
				},
				correlation,
			},
			path,
		);
		// The chain as it stands now: a route added while this one waits on a
		// resolver takes the next request, not this one.
		for (const route of [...routes].reverse()) {
			if (!route.active) continue;
			if (route.method !== undefined && route.method !== request.method)
				continue;
			const params = route.matcher.match(request.url);
			if (params === undefined) continue;
			const view = restRequest(request, correlation, params);
			try {
				if (route.match !== undefined && !route.match(view)) continue;
				// Claimed before the resolver runs, which may wait: two requests
				// at once cannot both take a route's last turn.
				route.hits += 1;
				if (route.remaining !== undefined && --route.remaining === 0)
					retire(route);
				route.requests.push(view);
				const reply =
					typeof route.resolver === "function"
						? await route.resolver(view)
						: route.resolver;
				if ((await answer(reply, response, path, correlation)) !== undefined)
					return;
			} catch (error) {
				await fail(route, error, response, path, correlation);
				return;
			}
		}
		record(
			{
				kind: "response",
				direction: "in",
				source: "server",
				data: "",
				meta: { status: 404, headers: TEXT, unmatched: true },
				correlation,
			},
			path,
		);
		await response.send(
			404,
			TEXT,
			`wirestage: ${name} has no route for ${request.method} ${path}`,
		);
	};

	const listening = await serveHttp(
		{
			name,
			...(options.host === undefined ? {} : { host: options.host }),
			...(options.port === undefined ? {} : { port: options.port }),
		},
		handle,
	);
	url = listening.url;

	const on: RestApi["on"] = async (
		method,
		path,
		resolver,
		routeOptions = {},
	) => {
		if (
			routeOptions.times !== undefined &&
			(!Number.isInteger(routeOptions.times) || routeOptions.times < 1)
		)
			throw new WirestageError(
				"INVALID_ARGUMENT",
				`route "${method} ${String(path)}": times must be a positive integer, got ${routeOptions.times}`,
			);
		const label = `${method} ${String(path)}`;
		const route: Route = {
			label,
			method: method === "*" ? undefined : method,
			matcher: compilePath(path, options.baseURL),
			resolver,
			match: routeOptions.match,
			requests: createArrivals<RestRequest>({
				clock: deps.clock,
				label: `${label} request to ${name}`,
			}),
			remaining: routeOptions.times,
			hits: 0,
			active: true,
		};
		routes.push(route);
		return {
			get hits() {
				return route.hits;
			},
			get requests() {
				return route.requests.items;
			},
			next: (waitOptions) => route.requests.next(waitOptions),
			async remove() {
				retire(route);
			},
		};
	};

	const verb =
		(method: RestMethod): RestApi["get"] =>
		(path, resolver, routeOptions) =>
			on(method, path, resolver, routeOptions);

	let closing: Promise<void> | undefined;
	const server: RestServer = {
		url,
		port: listening.port,
		on,
		get: verb("GET"),
		post: verb("POST"),
		put: verb("PUT"),
		patch: verb("PATCH"),
		delete: verb("DELETE"),
		async calls(filter = {}) {
			return filterCalls(
				deps.timeline.frames({
					protocol: deps.protocol,
					where: (frame) => frame.meta["server"] === url,
				}),
				filter,
				options.baseURL,
			);
		},
		close() {
			closing ??= (async () => {
				for (const route of [...routes]) retire(route);
				deps.onClose(server);
				await listening.close();
			})();
			return closing;
		},
	};
	return server;
}
