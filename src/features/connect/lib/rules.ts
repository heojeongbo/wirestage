import type { DescMessage, DescMethod, MessageShape } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import {
	Code,
	createConnectRouter,
	createContextValues,
	type HandlerContext,
} from "@connectrpc/connect";
import type { UniversalHandler } from "@connectrpc/connect/protocol";

import type {
	HttpOutcome,
	HttpRequestView,
	HttpRuleHandle,
	PassthroughResponse,
	PluginContext,
} from "../../../entities/plugin/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type {
	ConnectOptions,
	HoldOptions,
	RpcProtocol,
} from "../model/types.js";
import {
	decodeRequestBody,
	decodeResponseBody,
	detectFormat,
	parseMessage,
	type WireFormat,
} from "./protocol.js";
import {
	type CallInfo,
	endpointOf,
	kCall,
	type Recorder,
	recordingImpl,
} from "./recorder.js";
import {
	collectResponse,
	pipeResponse,
	toUniversalRequest,
} from "./universal.js";

export type AnyImpl = (input: never, context: HandlerContext) => unknown;

/** One method's rule, as each kind of stub describes it. */
export interface RuleSpec<I extends DescMessage> {
	readonly method: DescMethod;
	readonly label: string;
	readonly options: HoldOptions<I> & { readonly delayMs?: number | undefined };
	/**
	 * Take calls in any RPC format, not only the protocols stubs answer: for
	 * a rule that watches and answers nothing.
	 */
	readonly anyProtocol?: boolean;
	/** Hear how a call this rule let through ended, and record it. */
	readonly observe?: boolean;
	/**
	 * Decide the call. Its request is already recorded, and `messages` are
	 * the request's messages decoded (none when they would not decode).
	 */
	respond(
		view: HttpRequestView,
		messages: readonly unknown[],
	): HttpOutcome | Promise<HttpOutcome>;
}

export interface RpcRules {
	/**
	 * Add one method's rule. Every stub goes through here, so every stub
	 * means the same by "a call to this method": the path, the protocols the
	 * plugin answers, the content type, `match` on the decoded request,
	 * `times`, the request on the timeline before the decision, `delayMs`.
	 */
	add<I extends DescMessage>(spec: RuleSpec<I>): Promise<HttpRuleHandle>;
	/**
	 * Connect's own server-side handler for one method: what makes a stub's
	 * bytes exactly a Connect server's. Built once per stub, not per call.
	 */
	handler(method: DescMethod, impl: AnyImpl): UniversalHandler;
	/** Answer a call through a handler. */
	answer(
		handler: UniversalHandler,
		method: DescMethod,
		view: HttpRequestView,
	): Promise<HttpOutcome>;
	/** The call a request is, as a stub answers it. */
	callOf(view: HttpRequestView): CallInfo;
}

/** Method kinds a page can call: fetch sends one request body, not a stream. */
const callable = (method: DescMethod): boolean =>
	method.methodKind === "unary" || method.methodKind === "server_streaming";

/**
 * Whether a request in `format` is a call `method` can be made with. Connect
 * names unary and streaming calls by content type — a stream's is not a
 * unary method's, nor the reverse — and offers GET only for a unary method
 * declared free of side effects; gRPC and gRPC-web make no such distinction.
 */
const speaks = (
	method: DescMethod,
	format: WireFormat,
	view: HttpRequestView,
): boolean => {
	const unary = method.methodKind === "unary";
	if (view.method === "GET")
		return (
			unary &&
			method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS
		);
	if (view.method !== "POST") return false;
	return format.protocol !== "connect" || format.enveloped !== unary;
};

/**
 * How an RPC method becomes an HTTP rule, and how its traffic is recorded.
 * The one place that knows both, shared by every stub of the plugin.
 */
export function createRpcRules(
	context: PluginContext,
	options: ConnectOptions,
	recorder: Recorder,
	protocol: string,
): RpcRules {
	const protocols = new Set<RpcProtocol>(
		options.protocols ?? ["connect", "grpc-web"],
	);
	const live = (options.streaming ?? "live") === "live";
	const base = options.baseURL?.replace(/\/+$/, "");
	const absolute = base !== undefined && /^[a-z][a-z\d+.-]*:\/\//i.test(base);
	/** What each request decodes to, worked out once however many rules ask. */
	const decoded = new WeakMap<
		HttpRequestView,
		{ readonly messages: readonly unknown[] } | { readonly error: unknown }
	>();
	/** Requests whose request side is on the timeline. */
	const recorded = new WeakSet<HttpRequestView>();

	const matchesPath = (requestPath: string) => (url: URL) => {
		if (base === undefined) return url.pathname.endsWith(requestPath);
		const subject = absolute ? `${url.origin}${url.pathname}` : url.pathname;
		return subject === `${base}${requestPath}`;
	};

	/** The format of a call this rule may take. */
	const accepts = (
		view: HttpRequestView,
		anyProtocol: boolean,
	): WireFormat | undefined => {
		const format = detectFormat(view);
		if (format === undefined || anyProtocol) return format;
		// gRPC-web-text is base64 on the wire, which Connect's handlers do
		// not speak: such a call is left to the real backend, not answered
		// with a 415.
		return protocols.has(format.protocol) && !format.base64
			? format
			: undefined;
	};

	const decode = (method: DescMethod, view: HttpRequestView) => {
		let result = decoded.get(view);
		if (result === undefined) {
			// `accepts` passed before any rule decodes: the request has a format.
			const format = detectFormat(view) as WireFormat;
			try {
				result = {
					messages: decodeRequestBody(format, view).map((bytes) =>
						parseMessage(
							method.input,
							bytes,
							format.binary,
							options.jsonOptions,
						),
					),
				};
			} catch (error) {
				result = { error };
			}
			decoded.set(view, result);
		}
		return result;
	};

	const callOf = (view: HttpRequestView): CallInfo => ({
		correlation: view.correlation,
		from: "page",
		answeredBy: "stub",
		rpcProtocol: detectFormat(view)?.protocol,
		page: view.page,
		context: view.context,
		requestRecorded: true,
	});

	/** Put the request side on the timeline, once per request. */
	const recordRequest = (
		method: DescMethod,
		view: HttpRequestView,
	): readonly unknown[] => {
		const result = decode(method, view);
		const failed = "error" in result;
		if (!recorded.has(view)) {
			recorded.add(view);
			const call = callOf(view);
			if (failed) {
				// It would not decode; it still lands, raw, so nothing vanishes.
				context.log.debug(
					"could not decode an RPC request",
					{ endpoint: endpointOf(method) },
					result.error,
				);
				context.timeline.append({
					protocol,
					kind: "request",
					direction: "out",
					endpoint: endpointOf(method),
					source: call.from,
					correlation: call.correlation,
					data: view.body(),
					meta: {
						rpcProtocol: call.rpcProtocol,
						decodeError: String(result.error),
					},
					page: call.page,
					context: call.context,
				});
			} else
				for (const [index, message] of result.messages.entries())
					recorder.out(call, method, message, index === 0);
		}
		return failed ? [] : result.messages;
	};

	/** Record what the real backend answered a call this plugin let through. */
	const recordResponse = (
		method: DescMethod,
		view: HttpRequestView,
		response: PassthroughResponse,
	) => {
		const format = detectFormat(view) as WireFormat;
		const call: CallInfo = { ...callOf(view), answeredBy: "network" };
		const body = decodeResponseBody(format, response);
		for (const bytes of body.messages) {
			try {
				recorder.in(
					call,
					method,
					parseMessage(
						method.output,
						bytes,
						format.binary,
						options.jsonOptions,
					),
				);
			} catch (error) {
				context.log.debug(
					"could not decode an RPC response",
					{ endpoint: endpointOf(method) },
					error,
				);
				context.timeline.append({
					protocol,
					kind: "message",
					direction: "in",
					endpoint: endpointOf(method),
					source: call.answeredBy,
					correlation: call.correlation,
					data: bytes,
					meta: {
						rpcProtocol: call.rpcProtocol,
						decodeError: String(error),
					},
					page: call.page,
					context: call.context,
				});
			}
		}
		recorder.statusOf(
			call,
			method,
			body.status ?? { code: Code.Internal, message: "missing trailer" },
		);
	};

	const createHandler = (
		method: DescMethod,
		impl: AnyImpl,
	): UniversalHandler => {
		const router = createConnectRouter({
			connect: protocols.has("connect"),
			grpcWeb: protocols.has("grpc-web"),
			grpc: protocols.has("grpc"),
			...(options.jsonOptions === undefined
				? {}
				: { jsonOptions: options.jsonOptions }),
		});
		router.rpc(method, recordingImpl(method, impl, recorder) as never);
		return router.handlers[0] as UniversalHandler;
	};

	return {
		callOf,
		handler: createHandler,
		async answer(handler, method, view) {
			const call = callOf(view);
			const values = createContextValues().set(kCall, call);
			if (!live || method.methodKind !== "server_streaming")
				return {
					type: "fulfill",
					...(await collectResponse(
						await handler(toUniversalRequest(view, values)),
					)),
				};
			return {
				type: "stream",
				async open(stream) {
					call.cut = () => stream.cut();
					call.over = stream.closed;
					// The page letting go of the stream is the call's cancellation.
					const gone = new AbortController();
					void stream.closed.then(() => gone.abort());
					await pipeResponse(
						await handler(toUniversalRequest(view, values, gone.signal)),
						stream,
					);
				},
			};
		},
		async add<I extends DescMessage>(spec: RuleSpec<I>) {
			const { method, options: stub } = spec;
			if (!callable(method))
				throw new WirestageError(
					"UNSUPPORTED",
					`${endpointOf(method)} is a ${method.methodKind.replace("_", "-")} method, which a page cannot call through fetch; fake it for clients outside the browser with serve()`,
				);
			const anyProtocol = spec.anyProtocol === true;
			return context.http.add({
				protocol,
				label: spec.label,
				url: matchesPath(`/${method.parent.typeName}/${method.name}`),
				record: false,
				...(stub.times === undefined ? {} : { times: stub.times }),
				endpoint: () => endpointOf(method),
				match(view) {
					const format = accepts(view, anyProtocol);
					if (format === undefined) return false;
					if (anyProtocol) return true;
					if (!speaks(method, format, view)) return false;
					if (stub.match === undefined) return true;
					const result = decode(method, view);
					// A request that does not decode is not this stub's to answer.
					return (
						"messages" in result &&
						result.messages[0] !== undefined &&
						stub.match(result.messages[0] as MessageShape<I>, view)
					);
				},
				async handle(view) {
					const messages = recordRequest(method, view);
					if (stub.delayMs !== undefined)
						await context.clock.sleep(stub.delayMs);
					return spec.respond(view, messages);
				},
				...(spec.observe
					? {
							onPassthroughResponse: (
								response: PassthroughResponse,
								view: HttpRequestView,
							) => recordResponse(method, view, response),
							onPassthroughFailure: (
								error: string | undefined,
								view: HttpRequestView,
							) =>
								recorder.fault(
									{ ...callOf(view), answeredBy: "network" },
									method,
									"network",
									{ error },
								),
						}
					: {}),
			});
		},
	};
}
