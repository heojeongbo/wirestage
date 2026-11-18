import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import {
	type ClientHttp2Session,
	type ClientHttp2Stream,
	constants,
	connect as http2Connect,
	type OutgoingHttpHeaders,
} from "node:http2";
import {
	type AddressInfo,
	createServer as createTcpServer,
	type Server,
	type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { h2ProxyArgs, startH2Proxy } from "../../../features/h2-proxy/index.js";
import { WirestageError } from "../../lib/errors/index.js";
import type { Listening } from "../http-server/index.js";
import { type H2ProxyServerOptions, listenH2Proxy } from "./index.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let certificate: { key: Buffer; cert: Buffer };
beforeAll(() => {
	// Made with openssl per run, so no private key is ever committed.
	const dir = mkdtempSync(join(tmpdir(), "wirestage-h2-test-"));
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
		certificate = {
			key: readFileSync(join(dir, "key.pem")),
			cert: readFileSync(join(dir, "cert.pem")),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A port nothing listens on: taken, then let go. */
async function deadPort(): Promise<number> {
	const server = createTcpServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** A plain HTTP/1.1 server, as an app's dev server is. */
async function upstream(
	handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
	const server = createHttpServer(handle);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	return (server.address() as AddressInfo).port;
}

async function proxy(options: H2ProxyServerOptions = {}): Promise<Listening> {
	const listening = await listenH2Proxy(options);
	cleanups.push(() => listening.close());
	return listening;
}

/** Chromium's side of the proxy: one HTTP/2 connection, TLS not checked. */
function browser(listening: Listening): ClientHttp2Session {
	const session = http2Connect(listening.url, { rejectUnauthorized: false });
	session.on("error", () => {});
	cleanups.push(() => session.destroy());
	return session;
}

interface Answer {
	readonly status: number;
	readonly headers: Record<string, unknown>;
	readonly body: string;
}

/** A request sent the way Chromium sends a plain-http one to an h2 proxy. */
function send(
	session: ClientHttp2Session,
	port: number,
	path: string,
	headers: OutgoingHttpHeaders = {},
	body?: string,
): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const stream = session.request({
			":method": body === undefined ? "GET" : "POST",
			":scheme": "http",
			":authority": `127.0.0.1:${port}`,
			":path": path,
			...headers,
		});
		let answered: Record<string, unknown> = {};
		stream.on("response", (head) => {
			answered = head;
		});
		const chunks: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => chunks.push(chunk));
		stream.on("end", () =>
			resolve({
				status: Number(answered[":status"]),
				headers: answered,
				body: Buffer.concat(chunks).toString("utf8"),
			}),
		);
		stream.on("error", reject);
		stream.end(body);
	});
}

/** The code a stream was closed with, once it closes. */
const closedWith = (stream: ClientHttp2Stream) =>
	new Promise<number>((resolve) =>
		stream.once("close", () => resolve(stream.rstCode as number)),
	);

describe("an HTTP/2 proxy for the browser", () => {
	it("sends plain-http requests on over HTTP/1.1, and their answers back over HTTP/2", async () => {
		const seen: { method?: string; url?: string; host?: string }[] = [];
		const port = await upstream((request, response) => {
			seen.push({
				method: request.method,
				url: request.url,
				host: request.headers.host,
			});
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				response.writeHead(201, { "x-reply": "yes" });
				response.end(`got ${Buffer.concat(chunks).toString("utf8")}`);
			});
		});
		const session = browser(await proxy({ tls: certificate }));
		const [get, post] = await Promise.all([
			send(session, port, "/rooms?id=1"),
			send(session, port, "/rooms", {}, "a body"),
		]);
		expect(get).toMatchObject({ status: 201, body: "got " });
		expect(post.body).toBe("got a body");
		expect(get.headers["x-reply"]).toBe("yes");
		// HTTP/1.1's connection headers do not belong on an HTTP/2 response.
		expect(get.headers).not.toHaveProperty("connection");
		expect(get.headers).not.toHaveProperty("keep-alive");
		expect(seen).toEqual([
			{ method: "GET", url: "/rooms?id=1", host: `127.0.0.1:${port}` },
			{ method: "POST", url: "/rooms", host: `127.0.0.1:${port}` },
		]);
	});

	it("edits the HTML a navigation gets, uncompressed, and leaves every other answer as it came", async () => {
		const encodings: (string | undefined)[] = [];
		const port = await upstream((request, response) => {
			encodings.push(request.headers["accept-encoding"]);
			switch (request.url) {
				case "/page":
					response.writeHead(200, {
						"content-type": "text/html; charset=utf-8",
					});
					return response.end("<html><head></head><body>room</body></html>");
				case "/zipped":
					response.writeHead(200, {
						"content-type": "text/html",
						"content-encoding": "gzip",
					});
					return response.end(gzipSync("<p>zipped</p>"));
				case "/download":
					response.writeHead(200, {
						"content-type": "text/html",
						"content-disposition": "attachment; filename=room.html",
					});
					return response.end("<p>saved</p>");
				case "/untyped":
					return response.end("<p>untyped</p>");
				default:
					response.writeHead(200, { "content-type": "application/json" });
					return response.end("{}");
			}
		});
		const session = browser(
			await proxy({
				tls: certificate,
				transformHtml: (html, url) =>
					html.replace(
						"<head>",
						`<head><meta name="from" content="${url.pathname}">`,
					),
			}),
		);
		const navigate = {
			"sec-fetch-mode": "navigate",
			"accept-encoding": "gzip",
		};
		const page = await send(session, port, "/page", navigate);
		expect(page.body).toBe(
			'<html><head><meta name="from" content="/page"></head><body>room</body></html>',
		);
		expect(page.headers["content-length"]).toBe(
			String(Buffer.byteLength(page.body)),
		);
		// A fetch of the same document is not a navigation: as it came.
		expect(
			(
				await send(session, port, "/page", {
					"sec-fetch-mode": "cors",
					"accept-encoding": "gzip",
				})
			).body,
		).toBe("<html><head></head><body>room</body></html>");
		const zipped = await send(session, port, "/zipped", navigate);
		expect(zipped.headers["content-encoding"]).toBe("gzip");
		expect((await send(session, port, "/download", navigate)).body).toBe(
			"<p>saved</p>",
		);
		expect((await send(session, port, "/untyped", navigate)).body).toBe(
			"<p>untyped</p>",
		);
		expect((await send(session, port, "/data", navigate)).body).toBe("{}");
		// Only a navigation, with an edit to make, loses its accept-encoding.
		expect(encodings).toEqual([
			undefined,
			"gzip",
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("answers 502 for a server it cannot reach, an edit that throws, and a document cut short", async () => {
		const deadPort_ = await deadPort();
		const port = await upstream((request, response) => {
			response.writeHead(200, { "content-type": "text/html" });
			if (request.url === "/cut") {
				response.write("<html><head>");
				// Once the head and the first bytes are through, so the proxy is
				// reading the document when it breaks off.
				setTimeout(() => response.socket?.destroy(), 50);
				return;
			}
			response.end("<html><head></head></html>");
		});
		const session = browser(
			await proxy({
				tls: certificate,
				transformHtml: (html) => {
					if (html.includes("</html>"))
						throw new Error("the test's edit failed");
					return html;
				},
			}),
		);
		const navigate = { "sec-fetch-mode": "navigate" };
		expect((await send(session, deadPort_, "/")).status).toBe(502);
		expect((await send(session, port, "/edit", navigate)).status).toBe(502);
		expect((await send(session, port, "/cut", navigate)).status).toBe(502);
	});

	it("resets a stream whose answer the server cuts short, as a cut body reads on HTTP/1.1", async () => {
		const port = await upstream((_request, response) => {
			response.writeHead(200, {
				"content-type": "text/plain",
				"content-length": "100",
			});
			response.write("part");
			setImmediate(() => response.socket?.destroy());
		});
		const session = browser(await proxy({ tls: certificate }));
		const stream = session.request({
			":method": "GET",
			":scheme": "http",
			":authority": `127.0.0.1:${port}`,
			":path": "/",
		});
		stream.on("error", () => {});
		stream.resume();
		expect(await closedWith(stream)).not.toBe(constants.NGHTTP2_NO_ERROR);
	});

	it("lets go of the request when the page lets go first", async () => {
		let left!: () => void;
		const gone = new Promise<void>((resolve) => {
			left = resolve;
		});
		let arrived!: () => void;
		const asked = new Promise<void>((resolve) => {
			arrived = resolve;
		});
		// Never answered; the response closes only when its connection does.
		const port = await upstream((_request, response) => {
			response.on("close", left);
			arrived();
		});
		const session = browser(await proxy({ tls: certificate }));
		const stream = session.request({
			":method": "GET",
			":scheme": "http",
			":authority": `127.0.0.1:${port}`,
			":path": "/watch",
		});
		stream.on("error", () => {});
		await asked;
		stream.close(constants.NGHTTP2_CANCEL);
		await gone;
	});

	describe("CONNECT", () => {
		async function tcpServer(
			onSocket: (socket: Socket) => void,
		): Promise<number> {
			const server: Server = createTcpServer(onSocket);
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			cleanups.push(
				() => new Promise<void>((resolve) => server.close(() => resolve())),
			);
			return (server.address() as AddressInfo).port;
		}

		const open = (session: ClientHttp2Session, port: number) => {
			const stream = session.request({
				":method": "CONNECT",
				":authority": `127.0.0.1:${port}`,
			});
			stream.on("error", () => {});
			return stream;
		};

		it("tunnels the bytes both ways", async () => {
			const port = await tcpServer((socket) => socket.pipe(socket));
			const session = browser(await proxy({ tls: certificate }));
			const stream = open(session, port);
			const status = await new Promise<unknown>((resolve) =>
				stream.once("response", (head) => resolve(head[":status"])),
			);
			expect(status).toBe(200);
			stream.write("ping");
			const echoed = await new Promise<string>((resolve) =>
				stream.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))),
			);
			expect(echoed).toBe("ping");
		});

		it("answers 502 when the target cannot be reached, and resets a tunnel it loses", async () => {
			const session = browser(await proxy({ tls: certificate }));
			const refused = open(session, await deadPort());
			const head = await new Promise<unknown>((resolve) =>
				refused.once("response", (h) => resolve(h[":status"])),
			);
			expect(head).toBe(502);

			let reset!: () => void;
			const port = await tcpServer((socket) => {
				reset = () => socket.resetAndDestroy();
			});
			const lost = open(session, port);
			await new Promise((resolve) => lost.once("response", resolve));
			const code = closedWith(lost);
			reset();
			expect(await code).toBe(constants.NGHTTP2_INTERNAL_ERROR);
		});

		it("closes the target when the page closes the tunnel", async () => {
			let ended!: () => void;
			const closed = new Promise<void>((resolve) => {
				ended = resolve;
			});
			const port = await tcpServer((socket) => socket.on("close", ended));
			const session = browser(await proxy({ tls: certificate }));
			const stream = open(session, port);
			await new Promise((resolve) => stream.once("response", resolve));
			stream.close(constants.NGHTTP2_CANCEL);
			await closed;
		});
	});

	it("says what it needs when it cannot make its certificate", async () => {
		vi.stubEnv("PATH", "/nonexistent");
		const failed = listenH2Proxy({});
		await expect(failed).rejects.toBeInstanceOf(WirestageError);
		await expect(failed).rejects.toMatchObject({
			code: "UNSUPPORTED",
			message: expect.stringContaining("openssl"),
		});
	});

	it("gives the browser flags for itself, and for a port named before it starts", async () => {
		const started = await startH2Proxy({
			tls: certificate,
			host: "127.0.0.1",
			port: 0,
		});
		cleanups.push(() => started.close());
		expect(started.url).toBe(`https://127.0.0.1:${started.port}`);
		expect(started.chromiumArgs).toEqual([
			`--proxy-server=https://127.0.0.1:${started.port}`,
			"--proxy-bypass-list=<-loopback>",
			"--ignore-certificate-errors",
		]);
		expect(h2ProxyArgs(9443, "::1")[0]).toBe(
			"--proxy-server=https://[::1]:9443",
		);
		const defaults = await startH2Proxy();
		cleanups.push(() => defaults.close());
		expect(defaults.chromiumArgs[0]).toBe(
			`--proxy-server=https://127.0.0.1:${defaults.port}`,
		);
	});
});
