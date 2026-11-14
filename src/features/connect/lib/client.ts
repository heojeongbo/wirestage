import type { DescService } from "@bufbuild/protobuf";
import {
	type Client,
	ConnectError,
	createClient,
	type Interceptor,
	type Transport,
} from "@connectrpc/connect";
import {
	createConnectTransport,
	createGrpcTransport,
	createGrpcWebTransport,
	Http2SessionManager,
} from "@connectrpc/connect-node";

import type { CookieJarPort } from "../../../shared/api/playwright/index.js";
import { parseSetCookie } from "../../../shared/lib/cookies/index.js";
import type { RpcProtocol, StandaloneClientOptions } from "../model/types.js";
import { type CallInfo, type Recorder, tapIterable } from "./recorder.js";

export interface ClientDeps {
	/** Resolved per call, so a context attached after the client exists still counts. */
	readonly session: () => CookieJarPort | undefined;
	/** The time cookies are stamped against; the stage's clock in a stage. */
	readonly now?: () => number;
	readonly recorder?: Recorder;
	readonly correlation?: () => string;
	/**
	 * Handed the HTTP/2 connection a gRPC client opens, so its owner can close
	 * it. connect-node keeps an idle one for 15 minutes, and a server in the
	 * same process cannot finish closing while it is open (Node 22 waits).
	 */
	readonly onConnection?: (connection: Http2SessionManager) => void;
}

/** Sent with every call that did not set the header itself. */
function headersInterceptor(
	headers: Readonly<Record<string, string>>,
): Interceptor {
	return (next) => (request) => {
		for (const [name, value] of Object.entries(headers))
			if (!request.header.has(name)) request.header.set(name, value);
		return next(request);
	};
}

/**
 * Shares a context's cookie jar both ways, as Playwright's own request
 * context does — the reason hand-rolled gRPC-web helpers go through it. The
 * jar's cookies go out on the call, read per call: a sign-in during the test
 * is picked up, and a cookie scoped to another host or path is not sent. The
 * cookies a response sets come back into the jar — an error response's too,
 * which is how a sign-out or a refused sign-in clears a session.
 *
 * Cookies are scoped to the host the request names: its `host` header when
 * one was set, since that is the site the server takes it for.
 */
function sessionInterceptor(
	session: () => CookieJarPort | undefined,
	now: () => number,
): Interceptor {
	return (next) => async (request) => {
		const jar = session();
		if (jar === undefined) return next(request);
		const named = request.header.get("host");
		const site = new URL(request.url);
		if (named !== null) site.host = named;
		const cookies = await jar.cookies(site.href);
		if (cookies.length > 0 && !request.header.has("cookie"))
			request.header.set(
				"cookie",
				cookies.map((c) => `${c.name}=${c.value}`).join("; "),
			);
		const keep = async (headers: Headers) => {
			const set = headers
				.getSetCookie()
				.flatMap((line) => parseSetCookie(line, site.href, now()) ?? []);
			if (set.length > 0) await jar.addCookies?.(set);
		};
		try {
			const response = await next(request);
			await keep(response.header);
			return response;
		} catch (error) {
			// A failed call's headers ride on its error; one that never reached
			// the server has none.
			await keep(ConnectError.from(error).metadata);
			throw error;
		}
	};
}

/** Records drive calls on the timeline: the test's requests, the backend's answers. */
function recordingInterceptor(
	recorder: Recorder,
	correlation: () => string,
	protocol: RpcProtocol,
): Interceptor {
	return (next) => async (request) => {
		const call: CallInfo = {
			correlation: correlation(),
			from: "test",
			answeredBy: "network",
			rpcProtocol: protocol,
		};
		const method = request.method;
		try {
			if (!request.stream) recorder.out(call, method, request.message, true);
			const response = await next(
				request.stream
					? {
							...request,
							message: tapIterable(request.message, (m, i) =>
								recorder.out(call, method, m, i === 0),
							),
						}
					: request,
			);
			if (!response.stream) {
				recorder.in(call, method, response.message);
				recorder.status(call, method);
				return response;
			}
			return {
				...response,
				message: (async function* () {
					try {
						for await (const message of response.message) {
							recorder.in(call, method, message);
							yield message;
						}
						recorder.status(call, method);
					} catch (error) {
						recorder.status(call, method, ConnectError.from(error));
						throw error;
					}
				})(),
			};
		} catch (error) {
			recorder.status(call, method, ConnectError.from(error));
			throw error;
		}
	};
}

export function createTransport(
	options: StandaloneClientOptions,
	deps: ClientDeps,
): Transport {
	const protocol = options.protocol ?? "connect";
	// Outermost first: the defaults, then the session (which reads the `host`
	// the defaults may have named), then the recorder, closest to the wire.
	const interceptors: Interceptor[] = [];
	if (options.headers !== undefined)
		interceptors.push(headersInterceptor(options.headers));
	interceptors.push(sessionInterceptor(deps.session, deps.now ?? Date.now));
	if (deps.recorder !== undefined && deps.correlation !== undefined)
		interceptors.push(
			recordingInterceptor(deps.recorder, deps.correlation, protocol),
		);
	const nodeOptions = options.ignoreHttpsErrors
		? { rejectUnauthorized: false }
		: undefined;
	const common = {
		baseUrl: options.baseURL,
		interceptors,
		useBinaryFormat: options.binary ?? true,
	};
	if (protocol === "grpc") {
		// The transport's own session manager would be out of reach; this one
		// is handed to whoever has to close it.
		const sessionManager = new Http2SessionManager(
			options.baseURL,
			undefined,
			nodeOptions,
		);
		deps.onConnection?.(sessionManager);
		return createGrpcTransport({ ...common, sessionManager });
	}
	const http1 = { ...common, httpVersion: "1.1" as const, nodeOptions };
	if (protocol === "grpc-web") return createGrpcWebTransport(http1);
	return createConnectTransport(http1);
}

/**
 * A typed client for a real backend, outside any stage: the `rpc` helper an
 * e2e suite otherwise writes by hand — framing, status parsing and all — per
 * protocol. Errors arrive as `ConnectError` with the server's code.
 *
 * Over gRPC it holds an HTTP/2 connection, which connect-node keeps for 15
 * minutes once idle. It does not keep the process alive, but a server in the
 * same process waits for it before it finishes closing. A stage's client is
 * closed with the stage.
 */
export function createRpcClient<S extends DescService>(
	service: S,
	options: StandaloneClientOptions,
): Client<S> {
	return createClient(
		service,
		createTransport(options, { session: () => options.session }),
	);
}
