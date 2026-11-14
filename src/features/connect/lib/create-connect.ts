import type { DescService } from "@bufbuild/protobuf";
import { type Client, createClient } from "@connectrpc/connect";
import type { Http2SessionManager } from "@connectrpc/connect-node";

import {
	definePlugin,
	type PluginContext,
	type WirePlugin,
} from "../../../entities/plugin/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import { createSequence } from "../../../shared/lib/id/index.js";
import type {
	ClientOptions,
	ConnectApi,
	ConnectOptions,
	RpcServer,
} from "../model/types.js";
import { assembleCalls } from "./calls.js";
import { createTransport } from "./client.js";
import { stubAbort, stubHold } from "./faults.js";
import { recordService } from "./record.js";
import { createRecorder, endpointOf } from "./recorder.js";
import { createRpcRules } from "./rules.js";
import { serveRoutes } from "./serve.js";
import { stubFailure, stubService, stubStream, stubUnary } from "./stubs.js";

/**
 * Connect, gRPC-web and gRPC: stubs answered by connect-es's own protocol
 * handlers, recording of real traffic, drive clients, and out-of-process
 * servers.
 *
 * The stubs never encode a frame by hand. Each one is a one-method Connect
 * router whose handler runs the real server-side protocol, so the bytes the
 * page receives are exactly what a Connect server would send — errors,
 * trailers, JSON and binary alike.
 */
export function connect(
	options: ConnectOptions = {},
): WirePlugin<"connect", ConnectApi> {
	return definePlugin({
		name: "connect",
		scope: "Connect",
		setup: (context) => createConnect(context, options),
	});
}

function createConnect(context: PluginContext, options: ConnectOptions) {
	const protocol = context.name;
	const live = (options.streaming ?? "live") === "live";
	const recorder = createRecorder(context.timeline, protocol);
	const rules = createRpcRules(context, options, recorder, protocol);
	const testCorrelation = createSequence("t");
	const serverCorrelation = createSequence("s");
	const servers = new Set<RpcServer>();
	/** Lets go of each call a hold still has, when the stage goes away. */
	const heldCalls = new Set<() => void>();
	/** The drive clients' HTTP/2 connections, closed with the stage. */
	const connections = new Set<Http2SessionManager>();
	/** The record rules being added, once: every context gets them. */
	let recording: Promise<unknown> | undefined;

	const api: ConnectApi = {
		service: (service, impl, stubOptions = {}) =>
			stubService(rules, service, impl, stubOptions),
		unary: (method, reply, stubOptions = {}) =>
			stubUnary(context, rules, method, reply, stubOptions),
		stream: (method, stubOptions = {}) =>
			stubStream(context, rules, recorder, method, stubOptions, live),
		fail: (method, code, message, stubOptions = {}) =>
			stubFailure(rules, method, code, message, stubOptions),
		abort: (method, abortOptions = {}) =>
			stubAbort(rules, recorder, method, abortOptions),
		hold: (method, holdOptions = {}) =>
			stubHold(context, rules, recorder, method, holdOptions, heldCalls),
		record: (service) => recordService(rules, service),
		async calls(method) {
			await context.sync();
			return assembleCalls(
				context.timeline.frames({ protocol, endpoint: endpointOf(method) }),
			);
		},
		client<S extends DescService>(
			service: S,
			clientOptions: ClientOptions = {},
		): Client<S> {
			const {
				session,
				baseURL: requested,
				...transportOptions
			} = clientOptions;
			const base = requested ?? options.baseURL ?? "/";
			const origin = context.attachments()[0]?.baseURL ?? context.baseURL;
			if (!/^https?:\/\//.test(base) && origin === undefined)
				throw new WirestageError(
					"INVALID_ARGUMENT",
					`client(${service.typeName}): "${base}" is relative and the stage has no baseURL; pass an absolute baseURL or give the stage one`,
				);
			return createClient(
				service,
				createTransport(
					{
						...transportOptions,
						baseURL: new URL(base, origin).href.replace(/\/+$/, ""),
						protocol:
							transportOptions.protocol ?? options.clientProtocol ?? "connect",
					},
					{
						// Resolved per call: a context attached after the client was made
						// still lends it its session.
						session: () =>
							session === null
								? undefined
								: (session ?? context.attachments()[0]?.cookies),
						now: () => context.clock.now(),
						recorder,
						correlation: testCorrelation,
						onConnection: (connection) => connections.add(connection),
					},
				),
			);
		},
		async serve(routes, serveOptions = {}) {
			const server = await serveRoutes(routes, serveOptions, {
				recorder,
				correlation: serverCorrelation,
			});
			const tracked: RpcServer = {
				url: server.url,
				port: server.port,
				close: async () => {
					servers.delete(tracked);
					await server.close();
				},
			};
			servers.add(tracked);
			return tracked;
		},
	};

	return {
		api,
		async attach() {
			const services = options.record;
			if (services === undefined) return;
			recording ??= (async () => {
				for (const service of services) await api.record(service);
			})().catch((error: unknown) => {
				// Only the first rule can fail, installing the context's route, and
				// the router takes it back: the next attach starts over.
				recording = undefined;
				throw error;
			});
			await recording;
		},
		async dispose() {
			for (const letGo of [...heldCalls]) letGo();
			// A drive client's connection outlives its calls; left open, a
			// server in the test's own process would wait for it on close.
			for (const connection of connections) connection.abort();
			connections.clear();
			await Promise.all([...servers].map((server) => server.close()));
		},
	};
}
