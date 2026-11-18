import type {
	DescMessage,
	DescMethod,
	DescMethodServerStreaming,
	DescMethodUnary,
	DescService,
	JsonReadOptions,
	JsonWriteOptions,
	MessageInitShape,
	MessageShape,
} from "@bufbuild/protobuf";
import type {
	Client,
	Code,
	ConnectRouter,
	HandlerContext,
	ServiceImpl,
} from "@connectrpc/connect";

import type { Frame, FrameSource } from "../../../entities/frame/index.js";
import type {
	AbortErrorCode,
	HttpRequestView,
	StreamEnd as ResponseEnd,
} from "../../../entities/plugin/index.js";
import type { CookieJarPort } from "../../../shared/api/playwright/index.js";

/** The three wire protocols connect-es speaks. Browsers use the first two. */
export type RpcProtocol = "connect" | "grpc-web" | "grpc";

export interface ConnectOptions {
	/**
	 * What the app's transport puts in front of `/<package>.<Service>/<Method>`:
	 * a path prefix (`/api`) on any origin, or an origin with one
	 * (`https://api.example.test/rpc`). Without it a stub matches that suffix
	 * under any prefix. It is also where `client()` calls by default.
	 */
	readonly baseURL?: string;
	/**
	 * Protocols stubs answer. Default: connect and grpc-web — the two a browser
	 * can speak. A call in another protocol passes every stub by. Native gRPC
	 * is for `serve()`.
	 */
	readonly protocols?: readonly RpcProtocol[];
	/**
	 * Services whose traffic is recorded and decoded even when nothing stubs
	 * it, so `calls()` sees the real backend's answers too.
	 */
	readonly record?: readonly DescService[];
	/**
	 * `live` (default) answers server streams from a local server, message by
	 * message, as the stub produces them. `buffered` collects the whole stream
	 * and fulfills it at once — the only choice on an https page without
	 * `streamServer.tls`, and only useful for streams that end.
	 */
	readonly streaming?: "live" | "buffered";
	/** The protocol `client()` uses by default. Default `connect`. */
	readonly clientProtocol?: RpcProtocol;
	readonly jsonOptions?: Partial<JsonReadOptions & JsonWriteOptions>;
}

export interface HoldOptions<I extends DescMessage = DescMessage> {
	/** Take this many calls, then leave the rest to the next rule. */
	readonly times?: number;
	/**
	 * Take only the calls this accepts; the rest go on to the next rule, or to
	 * the real backend. Gets the decoded request message, and the raw request
	 * for its headers. A request that does not decode never matches.
	 */
	readonly match?: (request: MessageShape<I>, view: HttpRequestView) => boolean;
}

export interface StubOptions<I extends DescMessage = DescMessage>
	extends HoldOptions<I> {
	/** Wait this long before answering. */
	readonly delayMs?: number;
}

export interface StubHandle {
	/** Calls this stub took. */
	readonly hits: number;
	remove(): Promise<void>;
}

export type UnaryReply<I extends DescMessage, O extends DescMessage> =
	| MessageInitShape<O>
	| ((
			request: MessageShape<I>,
			context: HandlerContext,
	  ) => MessageInitShape<O> | Promise<MessageInitShape<O>>);

export interface UnaryStub<I extends DescMessage> extends StubHandle {
	/** Requests received so far, decoded. */
	readonly requests: readonly MessageShape<I>[];
	/** The next request this stub receives (or already received and nobody took). */
	next(options?: { readonly timeout?: number }): Promise<MessageShape<I>>;
}

/**
 * How a test-driven stream ended: cleanly, with an error status (`failed`),
 * reset by the test (`cut`), or let go of by the page (`cancelled`).
 */
export type StreamEnd = ResponseEnd | "failed";

export interface StreamCall<I extends DescMessage, O extends DescMessage> {
	readonly request: MessageShape<I>;
	readonly requestHeaders: Headers;
	/** The protocol the page called with; undefined for an unidentified call. */
	readonly protocol: RpcProtocol | undefined;
	/**
	 * Send a message. Messages go out in order; this resolves once the
	 * message is written, and rejects with `CLOSED` when the stream ended
	 * before it was.
	 */
	send(message: MessageInitShape<O>): Promise<void>;
	/** End with OK. Resolves once the stream is over. */
	end(): Promise<void>;
	/** End with an error status. Resolves once the stream is over. */
	fail(code: Code, message?: string): Promise<void>;
	/**
	 * Reset the connection mid-stream: no status, no trailer — what a network
	 * drop looks like to the client. Recorded as a `cut` fault, not a status.
	 */
	cut(): Promise<void>;
	readonly closed: Promise<StreamEnd>;
}

export interface StreamStub<I extends DescMessage, O extends DescMessage>
	extends StubHandle {
	/** The next call the page opens (or already opened and nobody took). */
	next(options?: { readonly timeout?: number }): Promise<StreamCall<I, O>>;
	readonly calls: readonly StreamCall<I, O>[];
	/** Send to every open call. */
	broadcast(message: MessageInitShape<O>): Promise<void>;
}

/**
 * A call held at the network boundary until the test decides. Each decision
 * resolves once it is carried out, so `calls()` right after one sees it; the
 * first decision stands and later ones do nothing.
 */
export interface HeldCall<I extends DescMessage, O extends DescMessage> {
	readonly request: MessageShape<I> | undefined;
	readonly view: HttpRequestView;
	/**
	 * Let it go on: to the next rule that matches it, and to the real backend
	 * when there is none.
	 */
	release(): Promise<void>;
	/** Answer it with this message. */
	reply(message: MessageInitShape<O>): Promise<void>;
	/** Answer it with an error status. */
	fail(code: Code, message?: string): Promise<void>;
	/** Fail it at the network level. */
	abort(error?: AbortErrorCode): Promise<void>;
}

export interface HoldStub<I extends DescMessage, O extends DescMessage>
	extends StubHandle {
	next(options?: { readonly timeout?: number }): Promise<HeldCall<I, O>>;
	readonly calls: readonly HeldCall<I, O>[];
	/**
	 * Stop holding: every call held so far goes on, and so does every later
	 * one. A call already decided stays decided.
	 */
	releaseAll(): Promise<void>;
}

/**
 * What `rewrite()` does to a request: it gets a copy of the page's and returns
 * the one to send — that copy, changed, or another message.
 */
export type RequestEdit<I extends DescMessage> = (
	request: MessageShape<I>,
	view: HttpRequestView,
) => MessageInitShape<I>;

/** A call `nextCall()` found: its request, with its answer still to come. */
export interface PendingCall<I extends DescMessage, O extends DescMessage>
	extends Pick<
		RpcCall<I, O>,
		| "correlation"
		| "caller"
		| "page"
		| "context"
		| "protocol"
		| "request"
		| "requestHeaders"
	> {
	/**
	 * The whole call once it is over — answered, failed or faulted. Rejects
	 * with `TIMEOUT` when it is still open after `timeout` ms (default 5000),
	 * as a stream the page keeps open is.
	 */
	settled(options?: { readonly timeout?: number }): Promise<RpcCall<I, O>>;
}

/** One recorded RPC, reassembled from its frames. */
export interface RpcCall<I extends DescMessage, O extends DescMessage> {
	readonly correlation: string;
	/**
	 * Who made the call: `page`, `test` for a drive client, `network` for a
	 * client outside the browser calling a served fake. Undefined when the
	 * request never read as an RPC.
	 */
	readonly caller: FrameSource | undefined;
	/**
	 * Who answered: `stub`, `network` for the real backend, `server` for a
	 * served fake. Undefined while nobody has.
	 */
	readonly answeredBy: FrameSource | undefined;
	/** The page that made the call (`p1`, ...); undefined for a drive client's. */
	readonly page: string | undefined;
	/** Its browser context (`c1`, ...); undefined for a drive client's. */
	readonly context: string | undefined;
	readonly protocol: RpcProtocol | undefined;
	/** The first request message, as the caller sent it. */
	readonly request: MessageShape<I> | undefined;
	readonly requests: readonly MessageShape<I>[];
	/**
	 * The request's headers, names lower-cased: as the page sent them
	 * (cookies included), as a client outside the browser sent them to a
	 * served fake, or as a drive client set them before its transport added
	 * the protocol's own. Undefined when the request is not on the timeline.
	 */
	readonly requestHeaders: Readonly<Record<string, string>> | undefined;
	/**
	 * The request the backend got instead of `request`, when `rewrite()`
	 * changed it on the way. Undefined for a call sent on as it was.
	 */
	readonly forwarded: MessageShape<I> | undefined;
	readonly responses: readonly MessageShape<O>[];
	/** Undefined while the call is open, and when it ended in a fault. Code 0 is OK. */
	readonly status:
		| { readonly code: number; readonly message: string }
		| undefined;
	/**
	 * Why the call ended without a status: `abort` (a stub failed it), `cut`
	 * (the test reset the stream), `cancelled` (the page let go), `network`
	 * (the connection to the real backend failed).
	 */
	readonly fault: string | undefined;
	readonly frames: readonly Frame[];
}

export interface ClientOptions {
	/** Absolute, or a path resolved against the stage's base URL. */
	readonly baseURL?: string;
	readonly protocol?: RpcProtocol;
	/** Protobuf binary (default) or JSON on the wire. */
	readonly binary?: boolean;
	/** Sent with every call that does not set the header itself. */
	readonly headers?: Readonly<Record<string, string>>;
	/**
	 * Share a browser context's cookie jar: its cookies go out on the call, so
	 * the call is made as the signed-in page, and the cookies a response sets
	 * — an error response included — are kept in it. Pass the context.
	 * Defaults to the first attached context; `null` uses none.
	 */
	readonly session?: CookieJarPort | null;
	/** Accept self-signed certificates (dev servers). */
	readonly ignoreHttpsErrors?: boolean;
}

export interface StandaloneClientOptions
	extends Omit<ClientOptions, "baseURL" | "session"> {
	readonly baseURL: string;
	readonly session?: CookieJarPort;
}

export interface ServeOptions {
	/** 0, the default, picks a free port. A fixed port fails loudly when taken. */
	readonly port?: number;
	readonly host?: string;
	/** Protocols served. Default all three. */
	readonly protocols?: readonly RpcProtocol[];
	/**
	 * HTTP/2 (h2c). Required by native gRPC clients; an HTTP/1.1-only client
	 * (grpc-web, Connect over 1.1) needs it off. Default: on when `protocols`
	 * includes grpc.
	 */
	readonly http2?: boolean;
	/**
	 * How a call no route takes is answered: with this error status, in the
	 * caller's protocol, by connect-es's own handler — and recorded. For a
	 * fake of a backend the test has no descriptors for, or one that answers
	 * every method alike. Default: connect-es's 404, which gRPC clients read
	 * as `Unimplemented`.
	 */
	readonly unhandled?: { readonly code: Code; readonly message?: string };
}

export interface RpcServer {
	readonly url: string;
	readonly port: number;
	close(): Promise<void>;
}

export interface ConnectApi {
	/**
	 * Stub a whole service, or the methods of it that `impl` defines. A
	 * method a browser cannot call (client or bidirectional streaming) is
	 * refused: `serve()` is where those are faked.
	 */
	service<S extends DescService>(
		service: S,
		impl: Partial<ServiceImpl<S>>,
		options?: StubOptions,
	): Promise<StubHandle>;
	/** Stub one unary method with a message or a function of the request. */
	unary<I extends DescMessage, O extends DescMessage>(
		method: DescMethodUnary<I, O>,
		reply: UnaryReply<I, O>,
		options?: StubOptions<I>,
	): Promise<UnaryStub<I>>;
	/** Stub one server-streaming method and drive it from the test. */
	stream<I extends DescMessage, O extends DescMessage>(
		method: DescMethodServerStreaming<I, O>,
		options?: StubOptions<I>,
	): Promise<StreamStub<I, O>>;
	/** Answer every call to `method` with an error status. */
	fail<I extends DescMessage>(
		method: DescMethod & { readonly input: I },
		code: Code,
		message?: string,
		options?: StubOptions<I>,
	): Promise<StubHandle>;
	/** Fail every call to `method` at the network level. */
	abort<I extends DescMessage>(
		method: DescMethod & { readonly input: I },
		options?: StubOptions<I> & { readonly error?: AbortErrorCode },
	): Promise<StubHandle>;
	/** Hold calls until the test releases, answers or aborts each one. */
	hold<I extends DescMessage, O extends DescMessage>(
		method: DescMethodUnary<I, O> | DescMethodServerStreaming<I, O>,
		options?: HoldOptions<I>,
	): Promise<HoldStub<I, O>>;
	/**
	 * Send calls to `method` on to the real backend with the request the
	 * test rewrote: `edit` gets a copy of the page's and returns the request
	 * to send — the copy, changed, or another. The call is recorded with both — the
	 * page's as `request`, the rewrite as `forwarded` — and the backend's
	 * answer. A call that does not decode, or comes in gRPC-web-text, goes on
	 * as it was.
	 */
	rewrite<I extends DescMessage, O extends DescMessage>(
		method: DescMethodUnary<I, O> | DescMethodServerStreaming<I, O>,
		edit: RequestEdit<I>,
		options?: StubOptions<I>,
	): Promise<StubHandle>;
	/** Record and decode calls to this service without answering them. */
	record(service: DescService): Promise<StubHandle>;
	/**
	 * The next recorded call to `method` that `nextCall` has not returned yet,
	 * waiting for one if needed — whichever rule recorded it: a stub, a hold,
	 * a rewrite, a recording. Calls made before the first `nextCall` count.
	 * It resolves once the request is on the timeline; `settled()` waits for
	 * the answer.
	 */
	nextCall<I extends DescMessage, O extends DescMessage>(
		method: DescMethod & { readonly input: I; readonly output: O },
		options?: { readonly timeout?: number },
	): Promise<PendingCall<I, O>>;
	/** Every recorded call to `method`, oldest first. */
	calls<I extends DescMessage, O extends DescMessage>(
		method: DescMethod & { readonly input: I; readonly output: O },
	): Promise<RpcCall<I, O>[]>;
	/** A typed client for the real backend, signed in as the page. */
	client<S extends DescService>(service: S, options?: ClientOptions): Client<S>;
	/**
	 * Serve stubs on a port of their own, for clients outside the browser — a
	 * native gRPC client, a backend service under test. Calls are recorded.
	 */
	serve(
		routes: (router: ConnectRouter) => void,
		options?: ServeOptions,
	): Promise<RpcServer>;
}
