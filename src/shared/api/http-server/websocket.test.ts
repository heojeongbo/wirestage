import { connect, type Socket } from "node:net";
import { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createManualClock, createSystemClock } from "../../lib/clock/index.js";
import {
	createPorts,
	type PortPool,
	type ServedUpgrade,
	type ServedWebSocket,
	type WebSocketHandler,
} from "./index.js";
import { createServedWebSocket } from "./websocket.js";
import { encodeFrame, OPCODE } from "./websocket-frame.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY = "dGhlIHNhbXBsZSBub25jZQ==";

const pools: PortPool[] = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.close();
});

const pool = (options: { closeTimeoutMs?: number } = {}): PortPool => {
	const created = createPorts({ clock: createSystemClock(), ...options });
	pools.push(created);
	return created;
};

const bytesOf = (payload: Uint8Array | string): Uint8Array =>
	typeof payload === "string" ? encoder.encode(payload) : payload;

/** A frame as a client sends it: masked unless told otherwise. */
function clientFrame(
	opcode: number,
	payload: Uint8Array | string = new Uint8Array(0),
	options: { fin?: boolean; mask?: boolean; rsv?: number } = {},
): Uint8Array {
	const body = bytesOf(payload);
	const { fin = true, mask = true, rsv = 0 } = options;
	let extra = 0;
	if (body.length > 0xffff) extra = 8;
	else if (body.length > 125) extra = 2;
	const key = mask
		? new Uint8Array([0x37, 0xfa, 0x21, 0x3d])
		: new Uint8Array(0);
	const frame = new Uint8Array(2 + extra + key.length + body.length);
	const view = new DataView(frame.buffer);
	frame[0] = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
	let length = body.length;
	if (extra === 2) length = 126;
	if (extra === 8) length = 127;
	frame[1] = (mask ? 0x80 : 0) | length;
	if (extra === 2) view.setUint16(2, body.length);
	if (extra === 8) view.setBigUint64(2, BigInt(body.length));
	frame.set(key, 2 + extra);
	const start = 2 + extra + key.length;
	for (let i = 0; i < body.length; i++)
		frame[start + i] =
			(body[i] as number) ^ (mask ? (key[i & 3] as number) : 0);
	return frame;
}

/** A close frame's payload: the code, then the reason. */
const closeBody = (code: number, reason = ""): Uint8Array => {
	const text = encoder.encode(reason);
	const out = new Uint8Array(2 + text.length);
	out[0] = code >> 8;
	out[1] = code & 0xff;
	out.set(text, 2);
	return out;
};

interface ServerFrame {
	readonly opcode: number;
	readonly payload: Uint8Array;
	readonly text: string;
	/** A close frame's code, or undefined. */
	readonly code: number | undefined;
	readonly reason: string;
}

/** The frames a server sent, which are unmasked. */
function serverFrames(bytes: Uint8Array): ServerFrame[] {
	const frames: ServerFrame[] = [];
	let at = 0;
	while (at < bytes.length) {
		const opcode = (bytes[at] as number) & 0x0f;
		let length = (bytes[at + 1] as number) & 0x7f;
		let offset = at + 2;
		const view = new DataView(bytes.buffer, bytes.byteOffset);
		if (length === 126) {
			length = view.getUint16(at + 2);
			offset = at + 4;
		} else if (length === 127) {
			length = Number(view.getBigUint64(at + 2));
			offset = at + 10;
		}
		const payload = bytes.slice(offset, offset + length);
		const close = opcode === OPCODE.close && payload.length >= 2;
		frames.push({
			opcode,
			payload,
			text: decoder.decode(payload),
			code: close
				? ((payload[0] as number) << 8) | (payload[1] as number)
				: undefined,
			reason: close ? decoder.decode(payload.subarray(2)) : "",
		});
		at = offset + length;
	}
	return frames;
}

const join = (chunks: readonly Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
};

/**
 * A served WebSocket over an in-memory socket: what the client sends is
 * pushed in, what the server writes is kept.
 */
function inMemory(
	options: {
		maxPayload?: number;
		closeTimeoutMs?: number;
		onMessage?: (data: string | Uint8Array) => void;
	} = {},
) {
	const written: Uint8Array[] = [];
	const socket = new Duplex({
		read() {},
		write(chunk: Uint8Array, _encoding, done) {
			written.push(new Uint8Array(chunk));
			done();
		},
	});
	const received: (string | Uint8Array)[] = [];
	const clock = createManualClock();
	const served = createServedWebSocket(
		socket,
		"",
		options.onMessage ?? ((data) => received.push(data)),
		{
			clock,
			maxPayload: options.maxPayload ?? 1024,
			closeTimeoutMs: options.closeTimeoutMs ?? 1000,
		},
	);
	return {
		socket,
		served,
		received,
		clock,
		/** Frames from the client, in one chunk. */
		send: (...frames: Uint8Array[]) => socket.push(join(frames)),
		frames: () => serverFrames(join(written)),
		finished: new Promise<void>((resolve) => socket.once("finish", resolve)),
	};
}

/** A WebSocket client of bare TCP, for what a well-behaved client never sends. */
interface RawClient {
	readonly socket: Socket;
	/** The server's answer to the handshake, up to the blank line. */
	readonly head: string;
	/** Everything after the head the server sent so far. */
	body(): Uint8Array;
	frames(): ServerFrame[];
	/** Resolves when the server's end of the TCP connection is gone. */
	readonly closed: Promise<void>;
}

function rawClient(
	port: number,
	request: string,
	after: Uint8Array = new Uint8Array(0),
): Promise<RawClient> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		const chunks: Uint8Array[] = [];
		const closed = new Promise<void>((done) =>
			socket.once("close", () => done()),
		);
		socket.once("error", reject);
		let answered = false;
		socket.on("data", (chunk: Buffer) => {
			chunks.push(new Uint8Array(chunk));
			if (answered) return;
			const all = join(chunks);
			const end = decoder.decode(all).indexOf("\r\n\r\n");
			if (end < 0) return;
			answered = true;
			const head = decoder.decode(all).slice(0, end);
			const offset = encoder.encode(head).length + 4;
			const body = () => join(chunks).subarray(offset);
			resolve({
				socket,
				head,
				body,
				frames: () => serverFrames(body()),
				closed,
			});
		});
		socket.write(join([encoder.encode(request), after]));
	});
}

const handshake = (
	path = "/live",
	overrides: Record<string, string> = {},
	method = "GET",
): string =>
	[
		`${method} ${path} HTTP/1.1`,
		...Object.entries({
			host: "127.0.0.1",
			upgrade: "websocket",
			connection: "Upgrade",
			"sec-websocket-key": KEY,
			"sec-websocket-version": "13",
			...overrides,
		}).map(([name, value]) => `${name}: ${value}`),
		"",
		"",
	].join("\r\n");

/** A port whose WebSocket handshakes go to `handle`. */
async function serveSockets(handle: WebSocketHandler, ports = pool()) {
	return ports.listen({ name: "fake feed" }, { websocket: handle });
}

/** Until `check` holds, polling: what a socket does arrives on its own time. */
async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++)
		await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
}

describe("WebSocket handshakes", () => {
	it("accepts with the key's answer and the first subprotocol offered", async () => {
		const seen: ServedUpgrade[] = [];
		let served: ServedWebSocket | undefined;
		const server = await serveSockets((request, response) => {
			seen.push(request);
			served = response.accept(() => undefined);
		});
		const client = await rawClient(
			server.port,
			handshake("/live?since=4", {
				"sec-websocket-protocol": "v2, v1",
				"x-token": "t",
			}),
		);
		expect(client.head.split("\r\n")).toEqual([
			"HTTP/1.1 101 Switching Protocols",
			"upgrade: websocket",
			"connection: Upgrade",
			// RFC 6455's own example (§1.3).
			"sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
			"sec-websocket-protocol: v2",
		]);
		expect(seen[0]?.url.href).toBe(
			`ws://127.0.0.1:${server.port}/live?since=4`,
		);
		expect(seen[0]?.protocols).toEqual(["v2", "v1"]);
		expect(seen[0]?.headers["x-token"]).toBe("t");
		expect(served?.protocol).toBe("v2");
		expect(served?.open).toBe(true);
		client.socket.destroy();
	});

	it("agrees on no subprotocol when none was offered", async () => {
		let served: ServedWebSocket | undefined;
		const server = await serveSockets((_request, response) => {
			served = response.accept(() => undefined);
		});
		const client = await rawClient(server.port, handshake());
		expect(client.head).not.toContain("sec-websocket-protocol");
		expect(served?.protocol).toBe("");
		client.socket.destroy();
	});

	it("refuses what is no WebSocket handshake, before the handler sees it", async () => {
		const seen: ServedUpgrade[] = [];
		const server = await serveSockets((request, response) => {
			seen.push(request);
			response.accept(() => undefined);
		});
		const status = async (request: string) =>
			(await rawClient(server.port, request)).head.split("\r\n");
		expect(await status(handshake("/live", {}, "POST"))).toEqual(
			expect.arrayContaining(["HTTP/1.1 405 Method Not Allowed", "allow: GET"]),
		);
		expect((await status(handshake("/live", { upgrade: "h2c" })))[0]).toBe(
			"HTTP/1.1 400 Bad Request",
		);
		expect(
			await status(handshake("/live", { "sec-websocket-version": "8" })),
		).toEqual(
			expect.arrayContaining([
				"HTTP/1.1 426 Upgrade Required",
				"sec-websocket-version: 13",
			]),
		);
		expect(
			(await status(handshake("/live", { "sec-websocket-key": "short" })))[0],
		).toBe("HTTP/1.1 400 Bad Request");
		expect(seen).toEqual([]);
	});

	it("answers what the handler refuses with, and a 500 for one that throws first", async () => {
		const answers = new Map<string, WebSocketHandler>([
			["/missing", (_r, response) => response.refuse(404, {}, "no such feed")],
			["/odd", (_r, response) => response.refuse(599, {}, "")],
			[
				"/broken",
				() => {
					throw new Error("bug in the fake");
				},
			],
			[
				"/late",
				async (_r, response) => {
					response.accept(() => undefined);
					throw new Error("after accepting");
				},
			],
		]);
		const server = await serveSockets((request, response) =>
			(answers.get(request.url.pathname) as WebSocketHandler)(
				request,
				response,
			),
		);
		const missing = await rawClient(server.port, handshake("/missing"));
		expect(missing.head.split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
		await missing.closed;
		expect(decoder.decode(missing.body())).toBe("no such feed");
		const odd = await rawClient(server.port, handshake("/odd"));
		expect(odd.head.split("\r\n")[0]).toBe("HTTP/1.1 599 ");
		const broken = await rawClient(server.port, handshake("/broken"));
		await broken.closed;
		expect(broken.head.split("\r\n")[0]).toBe(
			"HTTP/1.1 500 Internal Server Error",
		);
		expect(decoder.decode(broken.body())).toBe(
			"wirestage: fake feed failed: bug in the fake",
		);
		// Accepted, then failed: the connection goes.
		const late = await rawClient(server.port, handshake("/late"));
		expect(late.head.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols");
		await late.closed;
	});

	it("reads frames the client sent along with its handshake", async () => {
		const received: (string | Uint8Array)[] = [];
		const server = await serveSockets((_request, response) => {
			response.accept((data) => received.push(data));
		});
		const client = await rawClient(
			server.port,
			handshake(),
			clientFrame(OPCODE.text, "early"),
		);
		await until(() => received.length === 1);
		expect(received).toEqual(["early"]);
		client.socket.destroy();
	});
});

describe("WebSocket messages", () => {
	it("carries text and bytes both ways, at every length encoding", async () => {
		const { served, send, received, frames } = inMemory({
			maxPayload: 70_000,
		});
		const sizes = [0, 125, 126, 65_535, 65_536];
		for (const size of sizes)
			send(clientFrame(OPCODE.binary, new Uint8Array(size).fill(7)));
		send(clientFrame(OPCODE.text, "héllo"));
		await until(() => received.length === sizes.length + 1);
		expect(
			received.slice(0, -1).map((data) => (data as Uint8Array).length),
		).toEqual(sizes);
		expect(received.at(-1)).toBe("héllo");
		for (const size of sizes) served.send(new Uint8Array(size).fill(9));
		served.send("back");
		expect(frames().map((f) => [f.opcode, f.payload.length])).toEqual([
			...sizes.map((size) => [OPCODE.binary, size]),
			[OPCODE.text, 4],
		]);
		expect(frames().at(-1)?.text).toBe("back");
	});

	it("joins fragments, answers a ping between them and ignores a pong", async () => {
		const { send, received, frames } = inMemory();
		// "é" is two bytes, split across the fragments.
		const word = encoder.encode("café");
		send(
			clientFrame(OPCODE.text, word.subarray(0, 4), { fin: false }),
			clientFrame(OPCODE.ping, "are you there"),
			clientFrame(OPCODE.pong, "unasked"),
			clientFrame(OPCODE.continuation, word.subarray(4)),
			clientFrame(OPCODE.binary, new Uint8Array([1]), { fin: false }),
			clientFrame(OPCODE.continuation, new Uint8Array([2]), { fin: false }),
			clientFrame(OPCODE.continuation, new Uint8Array([3])),
		);
		await until(() => received.length === 2);
		expect(received).toEqual(["café", new Uint8Array([1, 2, 3])]);
		expect(frames()).toMatchObject([
			{ opcode: OPCODE.pong, text: "are you there" },
		]);
	});

	it("reads a frame that arrives a byte at a time", async () => {
		const { socket, received } = inMemory({ maxPayload: 70_000 });
		const frame = clientFrame(OPCODE.binary, new Uint8Array(65_536).fill(1));
		const small = clientFrame(OPCODE.text, "x".repeat(200));
		for (const byte of frame.subarray(0, 12))
			socket.push(new Uint8Array([byte]));
		socket.push(frame.subarray(12));
		for (const byte of small) socket.push(new Uint8Array([byte]));
		await until(() => received.length === 2);
		expect((received[0] as Uint8Array).length).toBe(65_536);
		expect((received[1] as string).length).toBe(200);
	});
});

describe("WebSocket protocol errors", () => {
	const failures: [string, Uint8Array[], number][] = [
		[
			"an unmasked frame",
			[clientFrame(OPCODE.text, "x", { mask: false })],
			1002,
		],
		["a reserved bit", [clientFrame(OPCODE.text, "x", { rsv: 4 })], 1002],
		["an unknown opcode", [clientFrame(0x3, "x")], 1002],
		[
			"a fragmented ping",
			[clientFrame(OPCODE.ping, "x", { fin: false })],
			1002,
		],
		[
			"a ping over 125 bytes",
			[clientFrame(OPCODE.ping, "x".repeat(126))],
			1002,
		],
		[
			"a continuation of nothing",
			[clientFrame(OPCODE.continuation, "x")],
			1002,
		],
		[
			"a message inside a message",
			[
				clientFrame(OPCODE.text, "a", { fin: false }),
				clientFrame(OPCODE.text, "b"),
			],
			1002,
		],
		[
			"a frame over the limit",
			[clientFrame(OPCODE.binary, new Uint8Array(1025))],
			1009,
		],
		[
			"a frame over the limit by its 64-bit length",
			[clientFrame(OPCODE.binary, new Uint8Array(70_000))],
			1009,
		],
		[
			"fragments over the limit",
			[
				clientFrame(OPCODE.binary, new Uint8Array(600), { fin: false }),
				clientFrame(OPCODE.continuation, new Uint8Array(600)),
			],
			1009,
		],
		[
			"text that is not UTF-8",
			[clientFrame(OPCODE.text, new Uint8Array([0xff]))],
			1007,
		],
		["a 1-byte close", [clientFrame(OPCODE.close, new Uint8Array([3]))], 1002],
		[
			"a close code nobody may send",
			[clientFrame(OPCODE.close, closeBody(1005))],
			1002,
		],
		[
			"a close reason that is not UTF-8",
			[
				clientFrame(
					OPCODE.close,
					join([closeBody(1000), new Uint8Array([0xc3])]),
				),
			],
			1007,
		],
	];
	for (const [what, sent, code] of failures)
		it(`fails the connection with ${code} for ${what}`, async () => {
			const { served, send, frames, finished } = inMemory();
			send(...sent);
			await finished;
			expect(served.open).toBe(false);
			expect(frames().at(-1)).toMatchObject({ opcode: OPCODE.close, code });
			expect(frames().at(-1)?.reason).not.toBe("");
		});

	it("fails with 1011 when the message handler throws", async () => {
		const { send, frames, finished, socket, served } = inMemory({
			onMessage: () => {
				throw "not an Error";
			},
		});
		send(clientFrame(OPCODE.text, "x"));
		await finished;
		expect(frames()).toMatchObject([
			{ opcode: OPCODE.close, code: 1011, reason: "not an Error" },
		]);
		socket.push(null);
		await expect(served.closed).resolves.toEqual({
			code: 1011,
			reason: "not an Error",
			by: "server",
		});
	});

	it("stops reading at a protocol error during a close it started", async () => {
		const { served, send, frames, socket } = inMemory();
		const closing = served.close(1000);
		send(clientFrame(OPCODE.text, "x", { mask: false }));
		socket.push(null);
		await expect(closing).resolves.toEqual({
			code: 1000,
			reason: "",
			by: "server",
		});
		// Its own close only: the failure sends no second one.
		expect(frames().map((f) => f.opcode)).toEqual([OPCODE.close]);
	});
});

describe("closing a WebSocket", () => {
	it("answers the client's close with its code, and ends the connection", async () => {
		const { served, send, frames, finished, socket, received } = inMemory();
		send(
			clientFrame(OPCODE.close, closeBody(4001, "done here")),
			// Past the close: never read.
			clientFrame(OPCODE.text, "after"),
		);
		await finished;
		expect(served.open).toBe(false);
		expect(frames()).toMatchObject([
			{ opcode: OPCODE.close, code: 4001, reason: "" },
		]);
		served.send("dropped");
		expect(frames()).toHaveLength(1);
		socket.push(null);
		await expect(served.closed).resolves.toEqual({
			code: 4001,
			reason: "done here",
			by: "client",
		});
		expect(received).toEqual([]);
	});

	it("says 1005 for a close that carried no code", async () => {
		const { served, send, frames, finished, socket } = inMemory();
		send(clientFrame(OPCODE.close));
		await finished;
		expect(frames()).toMatchObject([
			{ opcode: OPCODE.close, payload: new Uint8Array(0) },
		]);
		socket.push(null);
		await expect(served.closed).resolves.toEqual({
			code: 1005,
			reason: "",
			by: "client",
		});
	});

	it("closes from its own end and waits for the client's answer", async () => {
		const { served, send, frames, finished, socket, received } = inMemory();
		const reason = "é".repeat(70);
		const closing = served.close(4000, reason);
		expect(served.open).toBe(false);
		expect(served.close(4000)).toBe(closing);
		const [frame] = frames();
		// Cut on a character to what the frame has room for.
		expect(frame?.code).toBe(4000);
		expect(encoder.encode(frame?.reason).length).toBe(122);
		// Still read until the client's close arrives.
		send(
			clientFrame(OPCODE.text, "in flight"),
			clientFrame(OPCODE.close, closeBody(4000)),
		);
		await finished;
		socket.push(null);
		await expect(closing).resolves.toEqual({
			code: 4000,
			reason: "é".repeat(61),
			by: "server",
		});
		expect(received).toEqual(["in flight"]);
		expect(frames()).toHaveLength(1);
	});

	it("closes with 1000 for a reason with no code, and with no code at all", async () => {
		const reasoned = inMemory();
		void reasoned.served.close(undefined, "bye");
		expect(reasoned.frames()).toMatchObject([{ code: 1000, reason: "bye" }]);
		const bare = inMemory();
		const closing = bare.served.close();
		expect(bare.frames()).toMatchObject([
			{ opcode: OPCODE.close, code: undefined },
		]);
		bare.socket.destroy();
		await expect(closing).resolves.toMatchObject({ code: 1005, by: "server" });
	});

	it("refuses a close code a server may not send", () => {
		const { served } = inMemory();
		for (const code of [999, 1004, 1005, 1006, 1015, 2999, 5000])
			expect(() => served.close(code)).toThrow(
				expect.objectContaining({ code: "INVALID_ARGUMENT" }),
			);
		expect(served.open).toBe(true);
	});

	it("drops a client that does not answer its close in time", async () => {
		const { served, clock, socket } = inMemory({ closeTimeoutMs: 50 });
		const closing = served.close(1001);
		await clock.advance(49);
		expect(socket.destroyed).toBe(false);
		await clock.advance(1);
		expect(socket.destroyed).toBe(true);
		await expect(closing).resolves.toMatchObject({ code: 1001, by: "server" });
	});

	it("cuts without a close frame, keeping a close already under way", async () => {
		const cut = inMemory();
		cut.served.cut();
		expect(cut.served.open).toBe(false);
		await expect(cut.served.closed).resolves.toEqual({
			code: 1006,
			reason: "",
			by: "server",
		});
		expect(cut.frames()).toEqual([]);
		const closing = inMemory();
		void closing.served.close(1000);
		closing.served.cut();
		await expect(closing.served.closed).resolves.toMatchObject({ code: 1000 });
	});

	it("reports a client that went without a close, by reset or by half-close", async () => {
		const reset = inMemory();
		reset.socket.emit("error", new Error("ECONNRESET"));
		reset.socket.destroy();
		await expect(reset.served.closed).resolves.toEqual({
			code: 1006,
			reason: "",
			by: "client",
		});
		const half = inMemory();
		half.socket.push(null);
		await half.finished;
		await expect(half.served.closed).resolves.toMatchObject({
			code: 1006,
			by: "client",
		});
	});
});

describe("ports", () => {
	const GET = (path: string) =>
		`GET ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n`;

	it("share one port between plain requests and WebSockets", async () => {
		const ports = pool();
		const sockets = await ports.listen(
			{ name: "fake logs", port: 0 },
			{
				websocket: (_request, response) => {
					response.accept(() => undefined).send("tail");
				},
			},
		);
		const requests = await ports.listen(
			{ name: "fake logs", port: sockets.port },
			{ request: (_request, response) => response.send(200, {}, "range") },
		);
		expect(requests.port).toBe(sockets.port);
		expect(await (await fetch(`${requests.url}/query`)).text()).toBe("range");
		const client = await rawClient(sockets.port, handshake("/tail"));
		await until(() => client.frames().length === 1);
		expect(client.frames()[0]?.text).toBe("tail");
		client.socket.destroy();
	});

	it("say WebSockets only when no share takes requests", async () => {
		const server = await serveSockets(() => undefined);
		const answer = await fetch(`${server.url}/`);
		expect(answer.status).toBe(426);
		expect(answer.headers.get("upgrade")).toBe("websocket");
		expect(await answer.text()).toBe(
			"wirestage: fake feed serves WebSockets only",
		);
	});

	it("hand a handshake to the request share while none takes WebSockets", async () => {
		const ports = pool();
		const server = await ports.listen(
			{ name: "fake" },
			{
				request: (request, response) =>
					response.send(200, {}, `plain ${request.headers["upgrade"]}`),
			},
		);
		const client = await rawClient(server.port, handshake());
		expect(client.head.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
		await until(() => decoder.decode(client.body()) === "plain websocket");
		client.socket.destroy();
	});

	it("refuse a second share of the same kind, and a share of nothing", async () => {
		const ports = pool();
		const both = await ports.listen(
			{ name: "first" },
			{
				request: (_request, response) => response.send(204, {}, ""),
				websocket: () => undefined,
			},
		);
		await expect(
			ports.listen(
				{ name: "second", port: both.port },
				{ request: (_request, response) => response.send(204, {}, "") },
			),
		).rejects.toMatchObject({
			code: "INVALID_STATE",
			message: `second: 127.0.0.1:${both.port} is already in use (another of this stage's servers takes its requests)`,
		});
		await expect(
			ports.listen(
				{ name: "third", port: both.port },
				{
					request: (_request, response) => response.send(204, {}, ""),
					websocket: () => undefined,
				},
			),
		).rejects.toThrow("takes its requests and WebSockets");
		await expect(ports.listen({ name: "none" }, {})).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
	});

	it("give a share back without closing the port while another holds it", async () => {
		const ports = pool();
		let accepted: ServedWebSocket | undefined;
		const sockets = await ports.listen(
			{ name: "feed" },
			{
				websocket: (_request, response) => {
					accepted = response.accept(() => undefined);
				},
			},
		);
		const requests = await ports.listen(
			{ name: "api", port: sockets.port },
			{ request: (_request, response) => response.send(200, {}, "api") },
		);
		// A plain connection held open, which the request share's release drops.
		const held = await rawClient(
			sockets.port,
			GET("/held").replace("close", "keep-alive"),
		);
		await requests.close();
		expect(requests.close()).toBe(requests.close());
		await held.closed;
		expect((await fetch(`${sockets.url}/`)).status).toBe(426);
		// The WebSocket share's release drops its connections and hands the
		// port's handshakes back to nobody: with no share left, it closes.
		const client = await rawClient(sockets.port, handshake());
		await until(() => accepted !== undefined);
		await sockets.close();
		await client.closed;
		await expect(fetch(`${sockets.url}/`)).rejects.toThrow();
	});

	it("stop taking handshakes once the WebSocket share is given back", async () => {
		const ports = pool();
		const sockets = await ports.listen(
			{ name: "feed" },
			{ websocket: () => undefined },
		);
		await ports.listen(
			{ name: "api", port: sockets.port },
			{
				request: (request, response) =>
					response.send(200, {}, request.url.pathname),
			},
		);
		await sockets.close();
		const client = await rawClient(sockets.port, handshake("/after"));
		expect(client.head.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
		client.socket.destroy();
	});

	it("share a fixed port asked for twice at once", async () => {
		const ports = pool();
		const free = await ports.listen(
			{ name: "probe" },
			{ websocket: () => undefined },
		);
		const port = free.port;
		await free.close();
		const [sockets, requests] = await Promise.all([
			ports.listen({ name: "feed", port }, { websocket: () => undefined }),
			ports.listen(
				{ name: "api", port },
				{ request: (_request, response) => response.send(200, {}, "") },
			),
		]);
		expect([sockets.port, requests.port]).toEqual([port, port]);
	});

	it("close every port with the pool", async () => {
		const ports = pool();
		const a = await ports.listen({ name: "a" }, { websocket: () => undefined });
		const b = await ports.listen({ name: "b" }, { websocket: () => undefined });
		await ports.close();
		await expect(fetch(`${a.url}/`)).rejects.toThrow();
		await expect(fetch(`${b.url}/`)).rejects.toThrow();
	});

	it("name the server when another process holds the port", async () => {
		const ports = pool();
		const other = pool();
		const taken = await other.listen(
			{ name: "other" },
			{ websocket: () => undefined },
		);
		await expect(
			ports.listen(
				{ name: "fake feed", port: taken.port },
				{ websocket: () => undefined },
			),
		).rejects.toMatchObject({
			code: "INVALID_STATE",
			message: `fake feed: 127.0.0.1:${taken.port} is already in use`,
		});
		// The failed open is forgotten: the next listen tries again.
		await taken.close();
		const retried = await ports.listen(
			{ name: "fake feed", port: taken.port },
			{ websocket: () => undefined },
		);
		expect(retried.port).toBe(taken.port);
	});
});

describe("server frames", () => {
	it("encodes each length the way a client reads it", () => {
		for (const size of [0, 125, 126, 65_535, 65_536])
			expect(
				serverFrames(encodeFrame(OPCODE.binary, new Uint8Array(size))).map(
					(frame) => frame.payload.length,
				),
			).toEqual([size]);
	});
});
