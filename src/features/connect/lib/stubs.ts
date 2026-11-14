import type {
	DescMessage,
	DescMethod,
	DescMethodServerStreaming,
	DescMethodUnary,
	DescService,
	MessageInitShape,
	MessageShape,
} from "@bufbuild/protobuf";
import {
	type Code,
	Code as Codes,
	ConnectError,
	type HandlerContext,
	type ServiceImpl,
} from "@connectrpc/connect";

import type {
	HttpRuleHandle,
	PluginContext,
} from "../../../entities/plugin/index.js";
import {
	type Arrivals,
	createArrivals,
	createAsyncQueue,
	createDeferred,
} from "../../../shared/lib/async/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type {
	StreamCall,
	StreamEnd,
	StreamStub,
	StubHandle,
	StubOptions,
	UnaryReply,
	UnaryStub,
} from "../model/types.js";
import { endpointOf, kCall, type Recorder } from "./recorder.js";
import type { AnyImpl, RpcRules } from "./rules.js";

export const handleOf = (rule: HttpRuleHandle): StubHandle => ({
	get hits() {
		return rule.hits;
	},
	remove: () => rule.remove(),
});

/** The status a stub fails a call with. */
export const failure = (
	code: Code,
	message: string | undefined,
): ConnectError => new ConnectError(message ?? `stubbed ${Codes[code]}`, code);

/** An implementation that fails every call, for either kind a page can call. */
export const failingImpl = (
	method: DescMethod,
	code: Code,
	message: string | undefined,
): AnyImpl =>
	(method.methodKind === "server_streaming"
		? async function* () {
				yield* [];
				throw failure(code, message);
			}
		: async () => {
				throw failure(code, message);
			}) as AnyImpl;

/** One method answered by one implementation. */
const stubMethod = <I extends DescMessage>(
	rules: RpcRules,
	method: DescMethod,
	impl: AnyImpl,
	options: StubOptions<I>,
	label: string,
): Promise<HttpRuleHandle> => {
	const handler = rules.handler(method, impl);
	return rules.add({
		method,
		label,
		options,
		respond: (view) => rules.answer(handler, method, view),
	});
};

export async function stubService<S extends DescService>(
	rules: RpcRules,
	service: S,
	impl: Partial<ServiceImpl<S>>,
	options: StubOptions,
): Promise<StubHandle> {
	const added: HttpRuleHandle[] = [];
	const remove = async () => {
		await Promise.all(added.map((rule) => rule.remove()));
	};
	try {
		for (const method of service.methods) {
			const own = (impl as Record<string, AnyImpl | undefined>)[
				method.localName
			];
			if (own !== undefined)
				added.push(
					await stubMethod(
						rules,
						method,
						// A class instance or a stateful object: its methods need it.
						own.bind(impl) as AnyImpl,
						options,
						`stub ${endpointOf(method)}`,
					),
				);
		}
	} catch (error) {
		// All of the service or none of it.
		await remove();
		throw error;
	}
	if (added.length === 0)
		throw new WirestageError(
			"INVALID_ARGUMENT",
			`stub for ${service.typeName} implements none of its methods`,
		);
	return {
		get hits() {
			return added.reduce((sum, rule) => sum + rule.hits, 0);
		},
		remove,
	};
}

export async function stubUnary<I extends DescMessage, O extends DescMessage>(
	context: PluginContext,
	rules: RpcRules,
	method: DescMethodUnary<I, O>,
	reply: UnaryReply<I, O>,
	options: StubOptions<I>,
): Promise<UnaryStub<I>> {
	const requests = createArrivals<MessageShape<I>>({
		clock: context.clock,
		label: `${endpointOf(method)} request`,
	});
	const impl = async (request: MessageShape<I>, handler: HandlerContext) => {
		requests.push(request);
		return typeof reply === "function" ? reply(request, handler) : reply;
	};
	const rule = await stubMethod(
		rules,
		method,
		impl as AnyImpl,
		options,
		`unary ${endpointOf(method)}`,
	);
	return {
		...handleOf(rule),
		get hits() {
			return rule.hits;
		},
		get requests() {
			return requests.items;
		},
		next: (waitOptions) => requests.next(waitOptions),
	};
}

export async function stubStream<I extends DescMessage, O extends DescMessage>(
	context: PluginContext,
	rules: RpcRules,
	recorder: Recorder,
	method: DescMethodServerStreaming<I, O>,
	options: StubOptions<I>,
	live: boolean,
): Promise<StreamStub<I, O>> {
	if (!live)
		throw new WirestageError(
			"UNSUPPORTED",
			"stream() needs live streaming; it was configured as `buffered`",
		);
	/** Calls the stub took: each should become a stream. */
	let taken = 0;
	const calls: Arrivals<StreamCall<I, O>> = createArrivals({
		clock: context.clock,
		label: `${endpointOf(method)} stream`,
		// The stub took the call, yet no stream came of it: the redirect to
		// the stream server is what went missing.
		hint: (): string | undefined =>
			taken > calls.items.length
				? `${taken - calls.items.length} call(s) matched but never reached the local stream server — see "Live streams" in docs/troubleshooting.md`
				: undefined,
	});
	const impl = async function* (
		request: MessageShape<I>,
		handler: HandlerContext,
	) {
		const info = handler.values.get(kCall);
		const queue = createAsyncQueue<MessageInitShape<O>>();
		const closed = createDeferred<StreamEnd>();
		/** Once the response itself is over, not merely decided. */
		const over = async () => {
			await info.over;
		};
		const call: StreamCall<I, O> = {
			request,
			requestHeaders: handler.requestHeader,
			protocol: info.rpcProtocol,
			send: (message) => queue.push(message),
			async end() {
				queue.close();
				await over();
			},
			async fail(code, message) {
				queue.fail(failure(code, message));
				await over();
			},
			async cut() {
				// Settled and recorded here, not by what follows: the connection
				// resets asynchronously, after the queue has already ended, and
				// the implementation returning then must not read as an OK.
				closed.resolve("cut");
				recorder.fault(info, method, "cut");
				info.cut?.();
				queue.close();
				await over();
			},
			closed: closed.promise,
		};
		handler.signal.addEventListener("abort", () => {
			if (closed.settled) return;
			closed.resolve("cancelled");
			recorder.fault(info, method, "cancelled", { by: "page" });
			queue.close();
		});
		calls.push(call);
		try {
			for await (const message of queue) yield message;
			closed.resolve("ended");
		} catch (error) {
			closed.resolve("failed");
			throw error;
		}
	};
	const handler = rules.handler(method, impl as AnyImpl);
	const rule = await rules.add({
		method,
		label: `stream ${endpointOf(method)}`,
		options,
		respond(view) {
			taken += 1;
			return rules.answer(handler, method, view);
		},
	});
	return {
		...handleOf(rule),
		get hits() {
			return rule.hits;
		},
		next: (waitOptions) => calls.next(waitOptions),
		get calls() {
			return calls.items;
		},
		async broadcast(message) {
			for (const call of calls.items) await call.send(message).catch(() => {});
		},
	};
}

export async function stubFailure<I extends DescMessage>(
	rules: RpcRules,
	method: DescMethod & { readonly input: I },
	code: Code,
	message: string | undefined,
	options: StubOptions<I>,
): Promise<StubHandle> {
	return handleOf(
		await stubMethod(
			rules,
			method,
			failingImpl(method, code, message),
			options,
			`fail ${endpointOf(method)}`,
		),
	);
}
