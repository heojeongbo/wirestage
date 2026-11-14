import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createScopedLogger } from "../lib/logger/index.js";
import { listen, serveHttp } from "./http-server/index.js";
import {
	createStreamServer,
	type StreamServer,
} from "./stream-server/index.js";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	vi.restoreAllMocks();
});

describe("listen", () => {
	it("picks a free port and closes held-open connections at once", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200);
			response.write("first");
			// Never ends: close() must not wait for it.
		});
		const listening = await listen(server, { name: "test", protocol: "http" });
		expect(listening.url).toBe(`http://127.0.0.1:${listening.port}`);
		const response = await fetch(listening.url);
		const reader = response.body?.getReader();
		await reader?.read();
		await listening.close();
		await expect(reader?.read()).rejects.toThrow();
	});

	it("names the server and port when the port is taken", async () => {
		const first = await listen(createServer(), { name: "a", protocol: "http" });
		servers.push(first);
		await expect(
			listen(createServer(), {
				name: "fake backend",
				protocol: "http",
				port: first.port,
			}),
		).rejects.toMatchObject({
			code: "INVALID_STATE",
			message: `fake backend: 127.0.0.1:${first.port} is already in use`,
		});
	});

	it("passes other listen errors through", async () => {
		const server = createServer();
		await expect(
			listen(server, { name: "x", protocol: "http", host: "256.0.0.1" }),
		).rejects.toThrow();
	});

	it("brackets an IPv6 host in its URL", async () => {
		const listening = await listen(createServer(), {
			name: "v6",
			protocol: "http",
			host: "::1",
		});
		servers.push(listening);
		expect(listening.url).toBe(`http://[::1]:${listening.port}`);
		expect(new URL(listening.url).port).toBe(String(listening.port));
	});
});

describe("serveHttp", () => {
	it("hands each request over whole, and sends what the handler answers", async () => {
		const seen: unknown[] = [];
		const server = await serveHttp(
			{ name: "fake" },
			async (request, response) => {
				seen.push({
					method: request.method,
					path: request.url.pathname,
					query: request.url.searchParams.get("q"),
					origin: request.url.origin,
					header: request.headers["x-many"],
					body: new TextDecoder().decode(request.body),
				});
				await response.send(
					201,
					{ "set-cookie": "a=1\nb=2", "x-reply": "yes" },
					new Uint8Array([111, 107]),
				);
			},
		);
		servers.push(server);
		const answer = await fetch(`${server.url}/things?q=1`, {
			method: "POST",
			headers: [
				["x-many", "one"],
				["x-many", "two"],
			],
			body: "sent",
		});
		expect(answer.status).toBe(201);
		expect(await answer.text()).toBe("ok");
		// Two cookies stay two: joined, they would be one cookie no browser reads.
		expect(answer.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
		expect(answer.headers.get("x-reply")).toBe("yes");
		expect(seen).toEqual([
			{
				method: "POST",
				path: "/things",
				query: "1",
				origin: server.url,
				header: "one, two",
				body: "sent",
			},
		]);
	});

	it("drops the connection on reset, as a network failure would", async () => {
		const server = await serveHttp({ name: "fake" }, (_request, response) =>
			response.reset(),
		);
		servers.push(server);
		await expect(fetch(`${server.url}/`)).rejects.toThrow();
	});

	it("answers 500 for a handler that throws before answering, naming the server", async () => {
		const server = await serveHttp({ name: "fake ledger" }, () => {
			throw new Error("bug in the fake");
		});
		servers.push(server);
		const answer = await fetch(`${server.url}/`);
		expect(answer.status).toBe(500);
		expect(await answer.text()).toBe(
			"wirestage: fake ledger failed: bug in the fake",
		);
		const rejecting = await serveHttp({ name: "fake" }, async () => {
			throw "not an Error";
		});
		servers.push(rejecting);
		expect(await (await fetch(`${rejecting.url}/`)).text()).toBe(
			"wirestage: fake failed: not an Error",
		);
	});

	it("ends a response cut short when its handler throws after answering began", async () => {
		const server = await serveHttp(
			{ name: "fake" },
			async (_request, response) => {
				await response.send(200, {}, "complete");
				throw new Error("after the answer");
			},
		);
		servers.push(server);
		// What was sent stays sent; nothing else is written over it.
		expect(await (await fetch(`${server.url}/`)).text()).toBe("complete");
	});
});

describe("stream server", () => {
	const track = (server: StreamServer) => {
		servers.push(server);
		return server;
	};

	it("does not open a port until a session needs one", async () => {
		const server = track(createStreamServer());
		expect(server.sessions).toBe(0);
		await server.close();
	});

	it("serves one request per session, with CORS for the page's origin", async () => {
		const server = track(createStreamServer());
		const session = await server.open(
			(_request, response) => {
				response.writeHead(200, { "content-type": "text/plain" });
				response.end("streamed");
			},
			{ secure: false },
		);
		expect(server.sessions).toBe(1);
		const preflight = await fetch(session.url, {
			method: "OPTIONS",
			headers: {
				origin: "http://app.test",
				"access-control-request-headers": "x-grpc-web",
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-headers")).toBe(
			"x-grpc-web",
		);
		const response = await fetch(session.url, {
			headers: { origin: "http://app.test" },
		});
		expect(await response.text()).toBe("streamed");
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"http://app.test",
		);
		expect(response.headers.get("access-control-allow-credentials")).toBe(
			"true",
		);
		expect(response.headers.get("access-control-expose-headers")).toContain(
			"grpc-status",
		);
		// Single use: a reconnect has to go through the page's route again.
		expect((await fetch(session.url)).status).toBe(404);
	});

	it("closes every connection after one response", async () => {
		const server = track(createStreamServer());
		const session = await server.open(
			(_request, response) => {
				response.end("streamed");
			},
			{ secure: false },
		);
		/** A raw exchange, so nothing hides how the connection ends. */
		const exchange = (method: string, path: string) =>
			new Promise<string>((resolve) => {
				const url = new URL(path, session.url);
				const socket = connect(Number(url.port), url.hostname, () =>
					socket.write(
						`${method} ${url.pathname} HTTP/1.1\r\nhost: x\r\norigin: http://app.test\r\n\r\n`,
					),
				);
				let data = "";
				socket.on("data", (chunk) => {
					data += chunk.toString();
				});
				// The server ends it: the browser has no kept-alive connection
				// to re-send a request on.
				socket.on("end", () => resolve(data));
			});
		for (const [method, path, status] of [
			["OPTIONS", session.url, "204"],
			["GET", session.url, "200"],
			["GET", session.url, "404"],
		] as const) {
			const raw = await exchange(method, path);
			expect(raw).toMatch(new RegExp(`^HTTP/1.1 ${status} `));
			expect(raw.toLowerCase()).toContain("connection: close");
		}
	});

	it("agrees to a Private Network Access preflight, and only when asked", async () => {
		const server = track(createStreamServer());
		const session = await server.open(() => {}, { secure: false });
		const asked = await fetch(session.url, {
			method: "OPTIONS",
			headers: {
				origin: "https://app.example",
				"access-control-request-private-network": "true",
			},
		});
		expect(asked.headers.get("access-control-allow-private-network")).toBe(
			"true",
		);
		const plain = await fetch(session.url, {
			method: "OPTIONS",
			headers: { origin: "https://app.example" },
		});
		expect(
			plain.headers.get("access-control-allow-private-network"),
		).toBeNull();
	});

	it("allows any requested header when the preflight names none", async () => {
		const server = track(createStreamServer());
		const session = await server.open(() => {}, { secure: false });
		const preflight = await fetch(session.url, {
			method: "OPTIONS",
			headers: { origin: "http://app.test" },
		});
		expect(preflight.headers.get("access-control-allow-headers")).toBe("*");
	});

	it("answers 404 off the session path and for disposed sessions", async () => {
		const server = track(createStreamServer());
		const session = await server.open(() => {}, { secure: false });
		session.dispose();
		expect(server.sessions).toBe(0);
		expect((await fetch(session.url)).status).toBe(404);
		expect((await fetch(new URL("/elsewhere", session.url))).status).toBe(404);
		// A request line with no path at all.
		const raw = await new Promise<string>((resolve) => {
			const socket = connect(
				Number(new URL(session.url).port),
				"127.0.0.1",
				() =>
					socket.write(
						"GET * HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n",
					),
			);
			let data = "";
			socket.on("data", (chunk) => {
				data += chunk.toString();
			});
			socket.on("end", () => resolve(data));
		});
		expect(raw).toContain("404");
	});

	it("turns a throwing handler into a 500 and logs it", async () => {
		const log = createScopedLogger("Stream");
		const error = vi.spyOn(log, "error").mockImplementation(() => {});
		const server = track(createStreamServer({ log }));
		const failing = await server.open(
			() => {
				throw new Error("broken stub");
			},
			{ secure: false },
		);
		expect((await fetch(failing.url)).status).toBe(500);
		expect(error).toHaveBeenCalledWith(
			"stream handler failed",
			expect.objectContaining({ session: failing.id }),
			expect.any(Error),
		);
		// Headers already sent: the connection is cut, not ended — a clean
		// end would pass for the whole response.
		const late = await server.open(
			async (_request, response) => {
				response.writeHead(200);
				await new Promise((resolve) => response.write("partial", resolve));
				throw new Error("after headers");
			},
			{ secure: false },
		);
		const raw = await new Promise<string>((resolve) => {
			const url = new URL(late.url);
			const socket = connect(Number(url.port), url.hostname, () =>
				socket.write(`GET ${url.pathname} HTTP/1.1\r\nhost: x\r\n\r\n`),
			);
			let data = "";
			socket.on("data", (chunk) => {
				data += chunk.toString();
			});
			socket.on("close", () => resolve(data));
		});
		expect(raw).toMatch(/^HTTP\/1.1 200 /);
		expect(raw).toContain("partial");
		// No last chunk: the page sees a response cut short, not a whole one.
		expect(raw.endsWith("0\r\n\r\n")).toBe(false);
	});

	it("logs a failure on a connection already gone at debug, not error", async () => {
		const log = createScopedLogger("Stream");
		const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
		const error = vi.spyOn(log, "error").mockImplementation(() => {});
		const server = track(createStreamServer({ log }));
		const session = await server.open(
			(_request, response) => {
				response.destroy();
				throw new Error("write after destroy");
			},
			{ secure: false },
		);
		await expect(fetch(session.url)).rejects.toThrow();
		await vi.waitFor(() => expect(debug).toHaveBeenCalled());
		expect(error).not.toHaveBeenCalled();
		const quiet = track(createStreamServer());
		const gone = await quiet.open(
			(_request, response) => {
				response.destroy();
				throw new Error("x");
			},
			{ secure: false },
		);
		await expect(fetch(gone.url)).rejects.toThrow();
	});

	it("handles a failure with no logger", async () => {
		const server = track(createStreamServer());
		const failing = await server.open(() => Promise.reject(new Error("x")), {
			secure: false,
		});
		expect((await fetch(failing.url)).status).toBe(500);
	});

	it("refuses a scheme mismatch, naming the fix", async () => {
		const plain = track(createStreamServer());
		await expect(plain.open(() => {}, { secure: true })).rejects.toMatchObject({
			code: "UNSUPPORTED",
			message: expect.stringContaining("streamServer.tls"),
		});
		const tls = track(createStreamServer({ tls: selfSigned() }));
		await expect(tls.open(() => {}, { secure: false })).rejects.toMatchObject({
			code: "UNSUPPORTED",
			message: expect.stringContaining("drop `streamServer.tls`"),
		});
	});

	it("starts an https server when given TLS", async () => {
		const tls = track(createStreamServer({ tls: selfSigned() }));
		const session = await tls.open(
			(_request, response) => {
				response.end("secure");
			},
			{ secure: true },
		);
		expect(session.url.startsWith("https://127.0.0.1:")).toBe(true);
		const body = await new Promise<string>((resolve, reject) => {
			const url = new URL(session.url);
			import("node:https").then(({ request }) => {
				request(
					{
						host: url.hostname,
						port: url.port,
						path: url.pathname,
						rejectUnauthorized: false,
					},
					(response) => {
						let data = "";
						response.on("data", (chunk) => {
							data += chunk;
						});
						response.on("end", () => resolve(data));
					},
				)
					.on("error", reject)
					.end();
			}, reject);
		});
		expect(body).toBe("secure");
	});

	it("closes for good: twice is harmless, and nothing reopens it", async () => {
		const server = track(createStreamServer());
		const session = await server.open(() => {}, { secure: false });
		await server.close();
		await server.close();
		expect(server.sessions).toBe(0);
		await expect(fetch(session.url)).rejects.toThrow();
		// A stream opened as the stage goes away must not start a server
		// nobody will ever stop.
		await expect(
			server.open(() => {}, { secure: false }),
		).rejects.toMatchObject({ code: "CLOSED" });
	});

	it("spreads open streams over ports, so a seventh never waits on six", async () => {
		const server = track(createStreamServer());
		const held: (() => void)[] = [];
		const opened = async () => {
			const session = await server.open(
				(_request, response) => {
					response.writeHead(200);
					response.write("open");
					held.push(() => response.end());
				},
				{ secure: false },
			);
			const response = await fetch(session.url);
			await response.body?.getReader().read();
			return new URL(session.url).port;
		};
		const ports: string[] = [];
		for (let i = 0; i < 9; i++) ports.push(await opened());
		const perPort = new Map<string, number>();
		for (const port of ports) perPort.set(port, (perPort.get(port) ?? 0) + 1);
		// No port carries more than a browser would open connections to.
		expect(Math.max(...perPort.values())).toBeLessThanOrEqual(4);
		expect(perPort.size).toBe(3);
		// A stream that ends gives its place back.
		for (const end of held.splice(0, 4)) end();
		await vi.waitFor(async () => {
			const session = await server.open(() => {}, { secure: false });
			session.dispose();
			expect(new URL(session.url).port).toBe(ports[0]);
		});
		for (const end of held) end();
	});

	it("gives back the place of a session that is disposed or never used", async () => {
		const server = track(createStreamServer());
		const sessions = await Promise.all(
			Array.from({ length: 4 }, () => server.open(() => {}, { secure: false })),
		);
		const port = new URL(sessions[0]?.url ?? "").port;
		for (const session of sessions) session.dispose();
		// Disposing twice does not give the place back twice.
		sessions[0]?.dispose();
		const next = await Promise.all(
			Array.from({ length: 4 }, () => server.open(() => {}, { secure: false })),
		);
		expect(next.map((session) => new URL(session.url).port)).toEqual([
			port,
			port,
			port,
			port,
		]);
	});

	it("forgets a listener that could not start, and can still close", async () => {
		const server = track(createStreamServer({ host: "256.0.0.1" }));
		await expect(server.open(() => {}, { secure: false })).rejects.toThrow();
		expect(server.sessions).toBe(0);
		// The failure is not remembered: the next session tries again.
		await expect(server.open(() => {}, { secure: false })).rejects.toThrow();
		await expect(server.close()).resolves.toBeUndefined();
	});

	it("closes while a listener is still failing to start", async () => {
		const server = createStreamServer({ host: "256.0.0.1" });
		const opening = server.open(() => {}, { secure: false });
		await expect(server.close()).resolves.toBeUndefined();
		await expect(opening).rejects.toThrow();
	});
});

/**
 * A throwaway certificate for 127.0.0.1, made per run with openssl so no
 * private key is ever committed.
 */
function selfSigned(): { key: Buffer; cert: Buffer } {
	const dir = mkdtempSync(join(tmpdir(), "wirestage-tls-"));
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				join(dir, "key.pem"),
				"-out",
				join(dir, "cert.pem"),
				"-subj",
				"/CN=127.0.0.1",
				"-days",
				"1",
			],
			{ stdio: "ignore" },
		);
		return {
			key: readFileSync(join(dir, "key.pem")),
			cert: readFileSync(join(dir, "cert.pem")),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
