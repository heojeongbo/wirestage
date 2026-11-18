import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
	request as httpRequest,
	type IncomingMessage,
	type OutgoingHttpHeaders,
} from "node:http";
import {
	constants,
	createSecureServer,
	type OutgoingHttpHeaders as Http2OutgoingHeaders,
	type IncomingHttpHeaders,
	type ServerHttp2Stream,
} from "node:http2";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream";

import { WirestageError } from "../../lib/errors/index.js";
import { type Listening, listen } from "../http-server/index.js";

export interface ProxyCertificate {
	readonly key: string | Buffer;
	readonly cert: string | Buffer;
}

export interface H2ProxyServerOptions {
	/** Default 127.0.0.1. */
	readonly host?: string;
	/** 0, the default, picks a free port. */
	readonly port?: number;
	/** The proxy's certificate. Default: a self-signed one made for the run. */
	readonly tls?: ProxyCertificate;
	/** Edits the HTML document a navigation gets before the browser reads it. */
	readonly transformHtml?: (html: string, url: URL) => string;
}

/**
 * Connection-specific on HTTP/1.1, and refused in an HTTP/2 response: Node
 * throws on them in `respond()`.
 */
const CONNECTION_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
]);

/**
 * What the proxy does with an error a peer causes: a peer that goes away
 * mid-stream is routine for a proxy, not a failure, and an unheard error event
 * would end the test process.
 */
const ignore = (): void => {};

/**
 * An HTTPS forward proxy that speaks HTTP/2 to the browser and HTTP/1.1 to
 * each server, so a page's requests share one multiplexed connection however
 * many streams it holds open. Plain-http requests are sent on as they came;
 * a CONNECT (a WebSocket, an https origin) is tunnelled as bytes.
 */
export async function listenH2Proxy(
	options: H2ProxyServerOptions,
): Promise<Listening> {
	const server = createSecureServer(options.tls ?? selfSignedCertificate());
	server.on("session", (session) => session.on("error", ignore));
	server.on("stream", (stream, headers) => {
		stream.on("error", ignore);
		if (headers[":method"] === "CONNECT") tunnel(stream, headers);
		else forward(stream, headers, options.transformHtml);
	});
	return listen(server, {
		name: "wirestage HTTP/2 proxy",
		protocol: "https",
		...(options.host === undefined ? {} : { host: options.host }),
		...(options.port === undefined ? {} : { port: options.port }),
	});
}

/** One plain-http request, sent on to its authority over HTTP/1.1. */
function forward(
	stream: ServerHttp2Stream,
	headers: IncomingHttpHeaders,
	transformHtml: H2ProxyServerOptions["transformHtml"],
): void {
	const authority = String(headers[":authority"]);
	const path = String(headers[":path"]);
	const outgoing: OutgoingHttpHeaders = { host: authority };
	for (const [name, value] of Object.entries(headers))
		if (!name.startsWith(":")) outgoing[name] = value;
	// A document to edit has to arrive uncompressed.
	const edits =
		transformHtml !== undefined && headers["sec-fetch-mode"] === "navigate";
	if (edits) delete outgoing["accept-encoding"];

	let answered = false;
	const upstream = httpRequest(
		`http://${authority}${path}`,
		{ method: String(headers[":method"]), headers: outgoing },
		(response) => {
			response.once("end", () => {
				answered = true;
			});
			const back: Http2OutgoingHeaders = {
				":status": response.statusCode as number,
			};
			for (const [name, value] of Object.entries(response.headers))
				if (!CONNECTION_HEADERS.has(name)) back[name] = value;
			if (edits && isPlainHtml(response)) {
				sendEdited(response, stream, back, (html) =>
					transformHtml(html, new URL(`http://${authority}${path}`)),
				);
				return;
			}
			stream.respond(back);
			// A response the server cuts short resets the stream, which the page
			// reads as the same network error a cut HTTP/1.1 body would give it.
			pipeline(response, stream, ignore);
		},
	);
	upstream.on("error", () => fail(stream));
	// The page letting go ends the request it rode on, so the server sees the
	// viewer leave; once answered, the connection goes back to Node's pool.
	stream.on("close", () => {
		if (!answered) upstream.destroy();
	});
	stream.pipe(upstream);
}

/** A page to show: HTML, not compressed, not a file to save. */
function isPlainHtml(response: IncomingMessage): boolean {
	const { headers } = response;
	return (
		/^text\/html\b/i.test(headers["content-type"] ?? "") &&
		headers["content-encoding"] === undefined &&
		!/^\s*attachment/i.test(headers["content-disposition"] ?? "")
	);
}

/** Buffer an HTML document, edit it, and send it with its new length. */
function sendEdited(
	response: IncomingMessage,
	stream: ServerHttp2Stream,
	back: Http2OutgoingHeaders,
	edit: (html: string) => string,
): void {
	const chunks: Buffer[] = [];
	response.on("data", (chunk: Buffer) => chunks.push(chunk));
	response.on("error", () => fail(stream));
	response.on("end", () => {
		let body: Buffer;
		try {
			body = Buffer.from(edit(Buffer.concat(chunks).toString("utf8")));
		} catch {
			// The test's edit failed: the page gets an error, not a half-edit.
			fail(stream);
			return;
		}
		reply(stream, { ...back, "content-length": body.byteLength }, body);
	});
}

/** A CONNECT: a byte tunnel to the authority, which names its port. */
function tunnel(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
	const target = new URL(`http://${String(headers[":authority"])}`);
	const socket = connect(Number(target.port), target.hostname, () => {
		stream.respond({ ":status": 200 });
		socket.pipe(stream);
		stream.pipe(socket);
	});
	socket.on("error", () => fail(stream));
	stream.on("close", () => socket.destroy());
}

/**
 * End a stream that cannot be answered as the server would have: a 502 while
 * nothing has gone out, a reset after. Closing a closed stream does nothing.
 */
function fail(stream: ServerHttp2Stream): void {
	if (stream.headersSent) {
		stream.close(constants.NGHTTP2_INTERNAL_ERROR);
		return;
	}
	reply(stream, { ":status": 502 });
}

/**
 * Answer a stream in one piece. The page may have let go while the answer
 * was on its way, and `respond()` on a stream it reset would throw out of an
 * event handler, ending the test process.
 */
function reply(
	stream: ServerHttp2Stream,
	headers: Http2OutgoingHeaders,
	body?: Buffer,
): void {
	if (stream.destroyed) return;
	stream.respond(headers);
	stream.end(body);
}

/**
 * A certificate for one run, kept in memory. A browser launched with the
 * proxy's flags accepts it (`--ignore-certificate-errors`), which is all a
 * loopback test proxy needs.
 */
function selfSignedCertificate(): ProxyCertificate {
	const dir = mkdtempSync(join(tmpdir(), "wirestage-h2-proxy-"));
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:prime256v1",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=wirestage-h2-proxy",
				"-keyout",
				key,
				"-out",
				cert,
			],
			{ stdio: "ignore" },
		);
		return { key: readFileSync(key), cert: readFileSync(cert) };
	} catch (error) {
		throw new WirestageError(
			"UNSUPPORTED",
			"the HTTP/2 proxy could not make its certificate: it needs `openssl` on PATH, or pass `tls`",
			{ cause: error },
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
