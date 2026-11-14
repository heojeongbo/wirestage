import type { AddressInfo, Server, Socket } from "node:net";

import { WirestageError } from "../../lib/errors/index.js";

export interface ListenOptions {
	/** Names the server in the "port in use" error. */
	readonly name: string;
	readonly protocol: "http" | "https";
	readonly host?: string;
	/** 0, the default, picks a free port. */
	readonly port?: number;
}

export interface Listening {
	readonly url: string;
	readonly port: number;
	/** Stop accepting and drop open connections at once. */
	close(): Promise<void>;
}

/**
 * Start listening and return a handle whose `close` really is immediate.
 * `server.close()` alone waits for every keep-alive and streaming connection to
 * end on its own — a held-open stream would stall test teardown until the
 * runner's timeout.
 *
 * Takes a `net.Server`, which http, https and http2 servers all are.
 */
export async function listen(
	server: Server,
	options: ListenOptions,
): Promise<Listening> {
	const host = options.host ?? "127.0.0.1";
	const sockets = new Set<Socket>();
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		const onError = (error: NodeJS.ErrnoException) => {
			server.off("listening", onListening);
			reject(
				error.code === "EADDRINUSE"
					? new WirestageError(
							"INVALID_STATE",
							`${options.name}: ${host}:${options.port} is already in use`,
							{ cause: error, details: { host, port: options.port } },
						)
					: error,
			);
		};
		server.once("listening", onListening);
		server.once("error", onError);
		server.listen(options.port ?? 0, host);
	});
	const port = (server.address() as AddressInfo).port;
	return {
		// An IPv6 literal goes in brackets, or the port reads as part of it.
		url: `${options.protocol}://${host.includes(":") ? `[${host}]` : host}:${port}`,
		port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}
