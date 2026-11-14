import {
	createServer as createHttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { WirestageError } from "../../lib/errors/index.js";
import { randomToken } from "../../lib/id/index.js";
import type { ScopedLogger } from "../../lib/logger/index.js";
import { type Listening, listen } from "../http-server/index.js";

export type NodeHandler = (
	request: IncomingMessage,
	response: ServerResponse,
) => void | Promise<void>;

export interface StreamSession {
	readonly id: string;
	/** Where the browser's request is redirected to. Single use. */
	readonly url: string;
	/** Forget the session if the redirect never arrives. */
	dispose(): void;
}

export interface StreamServerOptions {
	/** Key and certificate for pages served over https. */
	readonly tls?: {
		readonly key: string | Buffer;
		readonly cert: string | Buffer;
	};
	readonly host?: string;
	readonly log?: ScopedLogger;
}

export interface StreamServer {
	/**
	 * Register a handler and return the URL to redirect one request to.
	 * `secure` is whether the page's request was https: Playwright only lets
	 * `route.continue` change the URL within the same scheme.
	 */
	open(
		handler: NodeHandler,
		options: { readonly secure: boolean },
	): Promise<StreamSession>;
	/** Stop every listener and refuse further sessions. */
	close(): Promise<void>;
	readonly sessions: number;
}

const PATH = "/__wirestage/";

/**
 * Headers a browser script may read on a response from another origin. The
 * redirect makes the stream server a different origin from the page as far
 * as CORS is concerned in some engines, and connect-web reads these.
 */
const EXPOSED_HEADERS = [
	"grpc-status",
	"grpc-message",
	"grpc-status-details-bin",
	"grpc-encoding",
	"connect-protocol-version",
	"content-encoding",
	"content-type",
].join(", ");

/**
 * Open responses one listener carries. A browser keeps at most six
 * connections to one host and port, and an open stream holds its connection
 * for as long as it lives: the seventh would wait for one of the six to end,
 * which in a test is never. Four leaves room for the preflights the browser
 * sends on the same connection pool.
 */
const STREAMS_PER_LISTENER = 4;

interface Listener {
	readonly listening: Promise<Listening>;
	/** Sessions given this listener's URL whose response has not closed. */
	open: number;
}

interface Session {
	readonly handler: NodeHandler;
	readonly listener: Listener;
}

/**
 * A local server for responses that must stay open — server streams, SSE —
 * which `route.fulfill` cannot express because it takes the whole body at
 * once. A stub answers by redirecting the browser's request here, and the
 * handler then writes to a real socket at whatever pace the test drives.
 *
 * It starts lazily on the first session, so a suite that never streams never
 * opens a port, and adds a port whenever the ones it has are full.
 */
export function createStreamServer(
	options: StreamServerOptions = {},
): StreamServer {
	const secure = options.tls !== undefined;
	const sessions = new Map<string, Session>();
	const listeners = new Set<Listener>();
	let closed = false;

	const release = (id: string, session: Session) => {
		if (sessions.delete(id)) session.listener.open -= 1;
	};

	const onRequest = (request: IncomingMessage, response: ServerResponse) => {
		allowCors(request, response);
		if (request.method === "OPTIONS") {
			response.writeHead(204);
			response.end();
			return;
		}
		const id = request.url?.startsWith(PATH)
			? request.url.slice(PATH.length)
			: "";
		const session = sessions.get(id);
		if (session === undefined) {
			response.writeHead(404);
			response.end();
			return;
		}
		// One request per session: a client that reconnects goes through the
		// page's route again and gets a session of its own. The session keeps
		// its place on the listener until the response is over.
		sessions.delete(id);
		response.once("close", () => {
			session.listener.open -= 1;
		});
		Promise.resolve()
			.then(() => session.handler(request, response))
			.catch((error: unknown) => {
				// A write into a connection the client closed, or a test cut, is
				// the expected end of a stream, not a failure worth an error line.
				if (response.destroyed) {
					options.log?.debug(
						"stream ended by a closed connection",
						{ session: id },
						error,
					);
					return;
				}
				options.log?.error("stream handler failed", { session: id }, error);
				if (!response.headersSent) response.writeHead(500);
				response.end();
			});
	};

	/** A listener with room, starting another when the rest are full. */
	const listenerWithRoom = (): Listener => {
		for (const listener of listeners)
			if (listener.open < STREAMS_PER_LISTENER) return listener;
		const listener: Listener = {
			listening: listen(
				options.tls === undefined
					? createHttpServer(onRequest)
					: createHttpsServer(options.tls, onRequest),
				{
					name: "wirestage stream server",
					protocol: secure ? "https" : "http",
					host: options.host,
				},
			),
			open: 0,
		};
		listeners.add(listener);
		// A listener that could not start must not be offered again.
		listener.listening.catch(() => listeners.delete(listener));
		return listener;
	};

	return {
		async open(handler, { secure: pageIsSecure }) {
			if (closed)
				throw new WirestageError(
					"CLOSED",
					"the stream server is closed: the stage was disposed while a stream was being opened",
				);
			if (pageIsSecure !== secure)
				throw new WirestageError(
					"UNSUPPORTED",
					pageIsSecure
						? "a live stream on an https page needs `streamServer.tls`: Playwright only redirects a request to a URL with the same scheme"
						: "the stream server was given TLS but the page is http; drop `streamServer.tls` for http pages",
					{ details: { pageIsSecure, serverIsSecure: secure } },
				);
			const listener = listenerWithRoom();
			const session: Session = { handler, listener };
			const id = randomToken();
			listener.open += 1;
			sessions.set(id, session);
			try {
				const { url } = await listener.listening;
				return {
					id,
					url: `${url}${PATH}${id}`,
					dispose: () => release(id, session),
				};
			} catch (error) {
				release(id, session);
				throw error;
			}
		},
		async close() {
			closed = true;
			sessions.clear();
			const stopping = [...listeners];
			listeners.clear();
			await Promise.all(
				stopping.map((listener) =>
					listener.listening.then(
						(listening) => listening.close(),
						// It never started; there is nothing to stop.
						() => undefined,
					),
				),
			);
		},
		get sessions() {
			return sessions.size;
		},
	};
}

function allowCors(request: IncomingMessage, response: ServerResponse): void {
	const origin = request.headers.origin;
	if (origin === undefined) return;
	response.setHeader("access-control-allow-origin", origin);
	response.setHeader("vary", "origin");
	response.setHeader("access-control-allow-credentials", "true");
	response.setHeader(
		"access-control-allow-methods",
		"GET, POST, PUT, PATCH, DELETE, OPTIONS",
	);
	response.setHeader(
		"access-control-allow-headers",
		request.headers["access-control-request-headers"] ?? "*",
	);
	response.setHeader("access-control-expose-headers", EXPOSED_HEADERS);
	// Private Network Access: a page on a public origin must be told the
	// loopback stream server agrees to be reached, or Chromium refuses.
	if (request.headers["access-control-request-private-network"] === "true")
		response.setHeader("access-control-allow-private-network", "true");
}
