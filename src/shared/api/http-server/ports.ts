import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import type { Clock } from "../../lib/clock/index.js";
import { WirestageError } from "../../lib/errors/index.js";
import { type Listening, listen } from "./listen.js";
import { answerRequest, type RequestHandler } from "./serve.js";
import { handleUpgrade, type WebSocketHandler } from "./upgrade.js";

export interface PortOptions {
	/** Names the server in errors, and in the 500 of a handler that throws. */
	readonly name: string;
	/** Default 127.0.0.1. */
	readonly host?: string;
	/** 0, the default, picks a free port. */
	readonly port?: number;
}

/** What one server takes of a port's traffic: at least one of the two. */
export interface PortShare {
	/** Plain HTTP requests. */
	readonly request?: RequestHandler;
	/** WebSocket handshakes. */
	readonly websocket?: WebSocketHandler;
}

/**
 * Ports for fakes served to clients outside the browser. A port already
 * listened on, on the same host, is shared: its plain requests go to the
 * share that takes requests and its WebSocket handshakes to the one that
 * takes those, as one real backend answers both on one port. A second share
 * of the same kind fails, as a port in use does.
 */
export interface Ports {
	/**
	 * `url` is `http://host:port`. `close` gives the share back and drops
	 * its connections; the port closes with its last share.
	 */
	listen(options: PortOptions, share: PortShare): Promise<Listening>;
}

export interface PortPool extends Ports {
	/** Close every port, whoever shares it. */
	close(): Promise<void>;
}

export interface PortPoolOptions {
	readonly clock: Clock;
	/** The largest WebSocket message a client may send. Default 100 MiB. */
	readonly maxPayload?: number;
	/** How long a WebSocket close waits for the client's. Default 1000 ms. */
	readonly closeTimeoutMs?: number;
}

interface Named<Handler> {
	readonly name: string;
	readonly handle: Handler;
}

interface Port {
	/** Where `ports` keeps it. */
	readonly key: string;
	readonly server: Server;
	readonly listening: Listening;
	readonly shares: {
		request?: Named<RequestHandler> | undefined;
		websocket?: Named<WebSocketHandler> | undefined;
	};
	/** Connections no upgrade took over: the request share's. */
	readonly plain: Set<Socket>;
	/** Connections an upgrade took over: the WebSocket share's. */
	readonly upgraded: Set<Duplex>;
	/** On the server while a share takes WebSockets. */
	readonly upgrade: (
		message: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => void;
}

const TEXT = { "content-type": "text/plain; charset=utf-8" };

export function createPorts(options: PortPoolOptions): PortPool {
	const timings = {
		clock: options.clock,
		maxPayload: options.maxPayload ?? 100 * 1024 * 1024,
		closeTimeoutMs: options.closeTimeoutMs ?? 1_000,
	};
	/** Open ports, by `host port`. */
	const ports = new Map<string, Port>();
	/** Ports being opened: a second share of one waits for the first. */
	const opening = new Map<string, Promise<Port>>();

	const open = async (
		listenOptions: PortOptions,
		host: string,
	): Promise<Port> => {
		const shares: Port["shares"] = {};
		const plain = new Set<Socket>();
		const upgraded = new Set<Duplex>();
		let origin = "";
		const server = createServer((message, response) => {
			const request = shares.request;
			if (request === undefined) {
				// The port is open, so a share takes WebSockets: say so, as a
				// WebSocket-only server does.
				response.writeHead(426, {
					...TEXT,
					upgrade: "websocket",
					connection: "Upgrade",
				});
				response.end(
					`wirestage: ${(shares.websocket as Named<WebSocketHandler>).name} serves WebSockets only`,
				);
				return;
			}
			answerRequest(message, response, request.handle, {
				name: request.name,
				origin,
			});
		});
		server.on("connection", (socket: Socket) => {
			plain.add(socket);
			socket.once("close", () => plain.delete(socket));
		});
		// Only on the server while a share takes WebSockets: with no `upgrade`
		// listener, Node hands a handshake to the request share as a plain GET.
		const upgrade = (
			message: IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => {
			plain.delete(socket as Socket);
			upgraded.add(socket);
			socket.once("close", () => upgraded.delete(socket));
			const websocket = shares.websocket as Named<WebSocketHandler>;
			handleUpgrade(message, socket, head, websocket.handle, {
				...timings,
				name: websocket.name,
				origin: origin.replace(/^http/, "ws"),
			});
		};
		const listening = await listen(server, {
			name: listenOptions.name,
			protocol: "http",
			host,
			...(listenOptions.port === undefined ? {} : { port: listenOptions.port }),
		});
		origin = listening.url;
		return {
			key: `${host} ${listening.port}`,
			server,
			listening,
			shares,
			plain,
			upgraded,
			upgrade,
		};
	};

	const portFor = async (
		listenOptions: PortOptions,
		host: string,
	): Promise<Port> => {
		const asked = listenOptions.port ?? 0;
		const key = `${host} ${asked}`;
		// Port 0 is a new port every time.
		const known =
			asked === 0 ? undefined : (ports.get(key) ?? opening.get(key));
		if (known !== undefined) return known;
		const pending = open(listenOptions, host);
		opening.set(key, pending);
		try {
			const port = await pending;
			ports.set(port.key, port);
			return port;
		} finally {
			opening.delete(key);
		}
	};

	const release = async (port: Port, share: PortShare): Promise<void> => {
		if (share.request !== undefined) {
			port.shares.request = undefined;
			for (const socket of port.plain) socket.destroy();
		}
		if (share.websocket !== undefined) {
			port.shares.websocket = undefined;
			port.server.off("upgrade", port.upgrade);
			for (const socket of port.upgraded) socket.destroy();
		}
		if (
			port.shares.request === undefined &&
			port.shares.websocket === undefined
		) {
			ports.delete(port.key);
			await port.listening.close();
		}
	};

	return {
		async listen(listenOptions, share) {
			if (share.request === undefined && share.websocket === undefined)
				throw new WirestageError(
					"INVALID_ARGUMENT",
					`${listenOptions.name}: a share of a port takes requests, WebSockets or both`,
				);
			const host = listenOptions.host ?? "127.0.0.1";
			const port = await portFor(listenOptions, host);
			const taken = [
				...(share.request && port.shares.request ? ["requests"] : []),
				...(share.websocket && port.shares.websocket ? ["WebSockets"] : []),
			];
			if (taken.length > 0)
				throw new WirestageError(
					"INVALID_STATE",
					`${listenOptions.name}: ${host}:${port.listening.port} is already in use (another of this stage's servers takes its ${taken.join(" and ")})`,
					{ details: { host, port: port.listening.port } },
				);
			if (share.request !== undefined)
				port.shares.request = {
					name: listenOptions.name,
					handle: share.request,
				};
			if (share.websocket !== undefined) {
				port.shares.websocket = {
					name: listenOptions.name,
					handle: share.websocket,
				};
				port.server.on("upgrade", port.upgrade);
			}
			let released: Promise<void> | undefined;
			return {
				url: port.listening.url,
				port: port.listening.port,
				close: () => {
					released ??= release(port, share);
					return released;
				},
			};
		},
		async close() {
			const open = [...ports.values()];
			ports.clear();
			await Promise.all(open.map((port) => port.listening.close()));
		},
	};
}
