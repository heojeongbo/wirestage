import { createServer as createHttpServer } from "node:http";
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

/** Serve Connect routes on a port of their own, recording every call. */
export async function serveRoutes(
	routes: (router: ConnectRouter) => void,
	options: ServeOptions,
	deps: ServeDeps,
): Promise<RpcServer> {
	const protocols = new Set(
		options.protocols ?? ["connect", "grpc-web", "grpc"],
	);
	const handler = connectNodeAdapter({
		connect: protocols.has("connect"),
		grpcWeb: protocols.has("grpc-web"),
		grpc: protocols.has("grpc"),
		routes: (router) => routes(recordingRouter(router, deps)),
		contextValues: (request) =>
			createContextValues().set(kCall, {
				correlation: deps.correlation(),
				// A client outside the browser, answered by the served fake.
				from: "network",
				answeredBy: "server",
				// Node always sets method and url on a server request; the types do
				// not say so. A Connect GET carries no content type at all.
				rpcProtocol: detectFormat({
					method: String(request.method),
					url: new URL(String(request.url), "http://localhost"),
					headers: {
						"content-type": String(request.headers["content-type"] ?? ""),
					},
				})?.protocol,
			}),
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
