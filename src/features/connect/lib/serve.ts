import {
	createServer as createHttpServer,
	type IncomingHttpHeaders,
} from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import type { Server } from "node:net";

import type { DescMethod, DescService } from "@bufbuild/protobuf";
import {
	type ConnectRouter,
	createContextValues,
	type ServiceImpl,
} from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";

import { listen } from "../../../shared/api/http-server/index.js";
import type { RpcServer, ServeOptions } from "../model/types.js";
import { detectFormat } from "./protocol.js";
import { kCall, type Recorder, recordingImpl } from "./recorder.js";
import { failingImpl } from "./stubs.js";
import { methodFromPath } from "./unhandled.js";

/** connect-node's handler; its package does not export the type by name. */
type NodeHandlerFn = ReturnType<typeof connectNodeAdapter>;
type NodeServerRequest = Parameters<NodeHandlerFn>[0];

export interface ServeDeps {
	readonly recorder: Recorder;
	readonly correlation: () => string;
}

/**
 * Route registrations, with every implementation wrapped for recording.
 * The caller writes ordinary Connect routes; nothing about recording leaks
 * into its code.
 */
function recordingRouter(
	router: ConnectRouter,
	deps: ServeDeps,
): ConnectRouter {
	// Bound to the object it came from: a class instance or a stateful fake
	// reads its own fields, and Connect would have called it that way.
	const wrap = (method: DescMethod, impl: unknown, owner?: unknown) =>
		recordingImpl(
			method,
			(impl as (...args: never[]) => unknown).bind(owner) as never,
			deps.recorder,
		);
	const proxy: ConnectRouter = {
		get handlers() {
			return router.handlers;
		},
		service(service, implementation, options) {
			const wrapped: Record<string, unknown> = {};
			for (const method of (service as DescService).methods) {
				const impl = (implementation as Record<string, unknown>)[
					method.localName
				];
				if (impl !== undefined)
					wrapped[method.localName] = wrap(method, impl, implementation);
			}
			router.service(
				service,
				wrapped as Partial<ServiceImpl<typeof service>>,
				options,
			);
			return proxy;
		},
		rpc(method, impl, options) {
			router.rpc(method, wrap(method, impl) as typeof impl, options);
			return proxy;
		},
	};
	return proxy;
}

/**
 * A Node request's headers as the timeline keeps them: one string each, and
 * none of HTTP/2's pseudo-headers, which a page's request does not have either.
 */
const headersOf = (headers: IncomingHttpHeaders): Record<string, string> =>
	Object.fromEntries(
		Object.entries(headers)
			.filter(([name]) => !name.startsWith(":"))
			.map(([name, value]) => [name, String(value)]),
	);

/** The wire format of a call made to a served fake. */
const formatOf = (request: NodeServerRequest) =>
	// Node always sets method and url on a server request; the types do not
	// say so. A Connect GET carries no content type at all.
	detectFormat({
		method: String(request.method),
		url: new URL(String(request.url), "http://localhost"),
		headers: {
			"content-type": String(request.headers["content-type"] ?? ""),
		},
	});

/** Serve Connect routes on a port of their own, recording every call. */
export async function serveRoutes(
	routes: (router: ConnectRouter) => void,
	options: ServeOptions,
	deps: ServeDeps,
): Promise<RpcServer> {
	const protocols = new Set(
		options.protocols ?? ["connect", "grpc-web", "grpc"],
	);
	const served = {
		connect: protocols.has("connect"),
		grpcWeb: protocols.has("grpc-web"),
		grpc: protocols.has("grpc"),
		contextValues: (request: NodeServerRequest) =>
			createContextValues().set(kCall, {
				correlation: deps.correlation(),
				// A client outside the browser, answered by the served fake.
				from: "network",
				answeredBy: "server",
				rpcProtocol: formatOf(request)?.protocol,
				headers: headersOf(request.headers),
			}),
	};
	const handler = connectNodeAdapter({
		...served,
		routes: (router) => routes(recordingRouter(router, deps)),
		...(options.unhandled === undefined
			? {}
			: { fallback: answerUnhandled(options.unhandled, served, deps) }),
	});
	const http2 = options.http2 ?? protocols.has("grpc");
	const server: Server = http2
		? createHttp2Server(handler)
		: createHttpServer(handler);
	const listening = await listen(server, {
		name: "wirestage rpc server",
		protocol: "http",
		host: options.host,
		port: options.port,
	});
	return {
		url: listening.url,
		port: listening.port,
		close: () => listening.close(),
	};
}

/**
 * Answer calls no route takes with an error status, through a handler made
 * for the method each call names — one per method and shape, kept — so the
 * error is encoded by connect-es in whichever protocol the call speaks.
 */
function answerUnhandled(
	unhandled: NonNullable<ServeOptions["unhandled"]>,
	served: Omit<Parameters<typeof connectNodeAdapter>[0], "routes">,
	deps: ServeDeps,
): NodeHandlerFn {
	const handlers = new Map<string, NodeHandlerFn>();
	return (request, response) => {
		const path = new URL(String(request.url), "http://localhost").pathname;
		const format = formatOf(request);
		const shape = {
			streaming: format?.enveloped === true,
			get: request.method === "GET",
		};
		const key = `${shape.streaming}:${shape.get}:${path}`;
		let handle = handlers.get(key);
		if (handle === undefined) {
			const method = methodFromPath(path, shape);
			// Not an RPC path at all: what connect-es answers it without a fallback.
			if (method === undefined) {
				response.writeHead(404);
				response.end();
				return;
			}
			handle = connectNodeAdapter({
				...served,
				routes: (router) =>
					recordingRouter(router, deps).rpc(
						method,
						failingImpl(method, unhandled.code, unhandled.message) as never,
					),
			});
			handlers.set(key, handle);
		}
		handle(request, response);
	};
}
