/**
 * A real Chromium for the browser project. Pages are served from an in-memory
 * origin through `context.route`, so no web server is needed and every test
 * page is a few lines of inline HTML.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "@playwright/test";

/**
 * A loopback origin, like an app under test on a dev server. A public origin
 * (`http://app.test`) would be blocked by Chromium's Private Network Access
 * from reaching the stream server on 127.0.0.1 — see docs/troubleshooting.md.
 */
export const ORIGIN = "http://localhost:4510";

let browser: Browser | undefined;

export async function launch(): Promise<Browser> {
	browser ??= await chromium.launch({
		// Local ICE candidates as plain IPs, so two peers in one page connect.
		args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
	});
	return browser;
}

export async function close(): Promise<void> {
	await browser?.close();
	browser = undefined;
}

/** A context whose ORIGIN serves `html` at `/` and 404s everything else. */
export async function contextWithPage(
	html: string,
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await (await launch()).newContext();
	// Registered FIRST, so every stage route added later sits above it.
	await context.route(`${ORIGIN}/**`, (route) =>
		new URL(route.request().url()).pathname === "/"
			? route.fulfill({ status: 200, contentType: "text/html", body: html })
			: route.fulfill({ status: 404, body: "not stubbed" }),
	);
	const page = await context.newPage();
	return { context, page };
}

/** One connection a {@link webSocketServer} accepted. */
export interface ServerSocket {
	/** Text messages the client sent, oldest first. */
	readonly received: string[];
	send(text: string): void;
	/** Start the closing handshake from the server's side. */
	close(code: number, reason?: string): void;
	/** The close frame the client sent; `code` is undefined when it had none. */
	readonly closed: Promise<{ code: number | undefined; reason: string }>;
}

const frame = (opcode: number, payload: Buffer): Buffer =>
	Buffer.concat([
		payload.length < 126
			? Buffer.from([0x80 | opcode, payload.length])
			: Buffer.from([
					0x80 | opcode,
					126,
					payload.length >> 8,
					payload.length & 0xff,
				]),
		payload,
	]);

/**
 * A real WebSocket server for the proxy tests. Node ships a client but no
 * server, and the tests need only text frames and the closing handshake of
 * RFC 6455, so that much is written out here.
 */
export async function webSocketServer(): Promise<{
	readonly url: string;
	/** The next connection (or one that arrived and nobody took). */
	next(): Promise<ServerSocket>;
	close(): Promise<void>;
}> {
	const arrived: ServerSocket[] = [];
	const waiting: ((socket: ServerSocket) => void)[] = [];
	const open = new Set<Duplex>();
	const server = createServer();
	server.on("upgrade", (request, socket: Duplex) => {
		open.add(socket);
		socket.on("close", () => open.delete(socket));
		socket.on("error", () => undefined);
		const accept = createHash("sha1")
			.update(
				`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
			)
			.digest("base64");
		socket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${accept}`,
				"",
				"",
			].join("\r\n"),
		);
		const received: string[] = [];
		let closing = false;
		let settle: (info: { code: number | undefined; reason: string }) => void =
			() => undefined;
		const closed = new Promise<{ code: number | undefined; reason: string }>(
			(resolve) => {
				settle = resolve;
			},
		);
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			// A client's frame: 2 header bytes, an optional 16-bit length, a
			// 4-byte mask, the masked payload. Test messages stay under 64 KiB.
			for (;;) {
				if (buffered.length < 2) return;
				const opcode = buffered.readUInt8(0) & 0x0f;
				const short = buffered.readUInt8(1) & 0x7f;
				const header = short === 126 ? 4 : 2;
				if (buffered.length < header) return;
				const length = short === 126 ? buffered.readUInt16BE(2) : short;
				if (buffered.length < header + 4 + length) return;
				const mask = buffered.subarray(header, header + 4);
				const payload = Buffer.from(
					buffered.subarray(header + 4, header + 4 + length),
				);
				for (let i = 0; i < payload.length; i++)
					payload.writeUInt8(payload.readUInt8(i) ^ mask.readUInt8(i % 4), i);
				buffered = buffered.subarray(header + 4 + length);
				if (opcode === 0x1) received.push(payload.toString("utf8"));
				if (opcode === 0x8) {
					// The closing handshake: answer the client's close frame
					// unless this side sent one first.
					if (!closing) socket.write(frame(0x8, payload));
					socket.end();
					settle({
						code: payload.length >= 2 ? payload.readUInt16BE(0) : undefined,
						reason: payload.subarray(2).toString("utf8"),
					});
				}
			}
		});
		const accepted: ServerSocket = {
			received,
			send: (text) => socket.write(frame(0x1, Buffer.from(text))),
			close(code, reason = "") {
				closing = true;
				const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
				payload.writeUInt16BE(code, 0);
				payload.write(reason, 2);
				socket.write(frame(0x8, payload));
			},
			closed,
		};
		const waiter = waiting.shift();
		if (waiter) waiter(accepted);
		else arrived.push(accepted);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `ws://127.0.0.1:${port}`,
		next: () => {
			const socket = arrived.shift();
			return socket === undefined
				? new Promise<ServerSocket>((resolve) => waiting.push(resolve))
				: Promise.resolve(socket);
		},
		async close() {
			for (const socket of open) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
