import {
	create,
	type DescMessage,
	type DescMethod,
	isMessage,
	type MessageShape,
	toBinary,
} from "@bufbuild/protobuf";
import {
	Code,
	ConnectError,
	createContextKey,
	type HandlerContext,
} from "@connectrpc/connect";

import type { FrameSource, Timeline } from "../../../entities/frame/index.js";
import type { RpcProtocol } from "../model/types.js";
import type { RpcStatus } from "./protocol.js";

/** What is known about one call, by whoever records its frames. */
export interface CallInfo {
	readonly correlation: string;
	/** Who makes the call: the page, the test's drive client, an outside client. */
	readonly from: FrameSource;
	/** Who answers it: a stub, the real network, a served fake. */
	readonly answeredBy: FrameSource;
	readonly rpcProtocol: RpcProtocol | undefined;
	readonly page?: string | undefined;
	readonly context?: string | undefined;
	/**
	 * The request side is already on the timeline: the rule that took the
	 * request recorded it before deciding how to answer.
	 */
	readonly requestRecorded?: boolean;
	/** Set on live streams: resets the underlying connection. */
	cut?: () => void;
	/** Set on live streams: settles once the response is over. */
	over?: Promise<unknown>;
}

/** A call nobody identified; the key's default, so a lookup never misses. */
const ANONYMOUS: CallInfo = Object.freeze({
	correlation: "anonymous",
	from: "page",
	answeredBy: "stub",
	rpcProtocol: undefined,
});

/**
 * How a call's identity reaches the implementation. Connect threads context
 * values from the server adapter into `HandlerContext.values`, which keeps the
 * recording wrapper free of globals and safe under concurrent calls.
 */
export const kCall = createContextKey<CallInfo>(ANONYMOUS, {
	description: "wirestage call",
});

export const endpointOf = (method: DescMethod): string =>
	`${method.parent.typeName}/${method.name}`;

export interface Recorder {
	/** A request-side message: the first is the `request` frame. */
	out(
		call: CallInfo,
		method: DescMethod,
		message: unknown,
		first: boolean,
	): void;
	/** A response-side message. */
	in(call: CallInfo, method: DescMethod, message: unknown): void;
	/** The call ended: OK when `error` is undefined. */
	status(call: CallInfo, method: DescMethod, error?: unknown): void;
	/** A status read off the wire (passthrough). */
	statusOf(call: CallInfo, method: DescMethod, status: RpcStatus): void;
	/**
	 * The call ended without a status: an abort, a cut, a dropped connection.
	 * `by` is who caused it, when that is not who was answering.
	 */
	fault(
		call: CallInfo,
		method: DescMethod,
		reason: string,
		detail?: { readonly error?: string | undefined; readonly by?: FrameSource },
	): void;
}

/**
 * Writes RPC frames. Every RPC, however it was answered, lands as the same
 * shape: a `request` frame from whoever called, `message` frames each way,
 * and one closing frame — a `response` with the status, or a `fault` when
 * there was none — so `calls()` reassembles stubbed, passed-through and
 * served calls the same way.
 *
 * A call ends once. A stream the test cut is over at the cut, whatever the
 * implementation goes on to return; the first ending is the one recorded.
 */
export function createRecorder(timeline: Timeline, protocol: string): Recorder {
	const ended = new WeakSet<CallInfo>();
	const base = (call: CallInfo, method: DescMethod) => ({
		protocol,
		endpoint: endpointOf(method),
		correlation: call.correlation,
		...(call.page === undefined ? {} : { page: call.page }),
		...(call.context === undefined ? {} : { context: call.context }),
	});
	const asMessage = <D extends DescMessage>(schema: D, value: unknown) =>
		(isMessage(value, schema)
			? value
			: create(schema, value as never)) as MessageShape<D>;
	const close = (
		call: CallInfo,
		method: DescMethod,
		status: RpcStatus,
		extra: Readonly<Record<string, unknown>> = {},
	) => {
		if (ended.has(call)) return;
		ended.add(call);
		timeline.append({
			...base(call, method),
			kind: "response",
			direction: "in",
			source: call.answeredBy,
			meta: {
				rpcProtocol: call.rpcProtocol,
				code: status.code,
				message: status.message,
				...extra,
			},
		});
	};
	return {
		out(call, method, message, first) {
			const value = asMessage(method.input, message);
			timeline.append({
				...base(call, method),
				kind: first ? "request" : "message",
				direction: "out",
				source: call.from,
				value,
				data: () => toBinary(method.input, value),
				meta: { rpcProtocol: call.rpcProtocol },
			});
		},
		in(call, method, message) {
			if (ended.has(call)) return;
			const value = asMessage(method.output, message);
			timeline.append({
				...base(call, method),
				kind: "message",
				direction: "in",
				source: call.answeredBy,
				value,
				data: () => toBinary(method.output, value),
				meta: { rpcProtocol: call.rpcProtocol },
			});
		},
		status(call, method, error) {
			if (error === undefined) {
				close(call, method, { code: 0, message: "" });
				return;
			}
			if (error instanceof ConnectError) {
				close(call, method, { code: error.code, message: error.rawMessage });
				return;
			}
			// Anything else reaches the page as Connect's own "internal error".
			// The frame records that, and keeps what was really thrown where
			// the test can read it and the page cannot.
			close(
				call,
				method,
				{ code: Code.Internal, message: "internal error" },
				{ thrown: String(error) },
			);
		},
		statusOf: (call, method, status) => close(call, method, status),
		fault(call, method, reason, detail = {}) {
			if (ended.has(call)) return;
			ended.add(call);
			timeline.append({
				...base(call, method),
				kind: "fault",
				direction: "none",
				source: detail.by ?? call.answeredBy,
				meta: {
					rpcProtocol: call.rpcProtocol,
					reason,
					...(detail.error === undefined ? {} : { error: detail.error }),
				},
			});
		},
	};
}

/**
 * The call a handler is serving. An unidentified one is recorded as
 * anonymous — each as a call of its own, so one ending does not end the next.
 */
export function callOf(context: HandlerContext): CallInfo {
	const call = context.values.get(kCall);
	return call === ANONYMOUS ? { ...ANONYMOUS } : call;
}

/** Wrap an iterable so `tap` sees every value as the consumer takes it. */
export async function* tapIterable<T>(
	source: AsyncIterable<T>,
	tap: (value: T, index: number) => void,
): AsyncGenerator<T> {
	let index = 0;
	for await (const value of source) {
		tap(value, index++);
		yield value;
	}
}

type AnyImpl = (input: never, context: HandlerContext) => unknown;

/**
 * Wrap an implementation of any of the four method kinds so every message
 * and the final status are recorded. The implementation itself is untouched:
 * it sees the same requests, and the client sees the same responses.
 */
export function recordingImpl(
	method: DescMethod,
	impl: AnyImpl,
	recorder: Recorder,
): AnyImpl {
	const run = impl as (input: unknown, context: HandlerContext) => unknown;
	/** The request side, unless the rule that took the request recorded it. */
	const request = (call: CallInfo, message: unknown, first: boolean) => {
		if (!call.requestRecorded) recorder.out(call, method, message, first);
	};
	switch (method.methodKind) {
		case "unary":
			return async (input: unknown, context: HandlerContext) => {
				const call = callOf(context);
				request(call, input, true);
				try {
					const response = await run(input, context);
					recorder.in(call, method, response);
					recorder.status(call, method);
					return response;
				} catch (error) {
					recorder.status(call, method, error);
					throw error;
				}
			};
		case "server_streaming":
			return async function* (input: unknown, context: HandlerContext) {
				const call = callOf(context);
				request(call, input, true);
				try {
					for await (const response of run(
						input,
						context,
					) as AsyncIterable<unknown>) {
						recorder.in(call, method, response);
						yield response;
					}
					recorder.status(call, method);
				} catch (error) {
					recorder.status(call, method, error);
					throw error;
				}
			};
		case "client_streaming":
			return async (
				requests: AsyncIterable<unknown>,
				context: HandlerContext,
			) => {
				const call = callOf(context);
				try {
					const response = await run(
						tapIterable(requests, (m, i) => request(call, m, i === 0)),
						context,
					);
					recorder.in(call, method, response);
					recorder.status(call, method);
					return response;
				} catch (error) {
					recorder.status(call, method, error);
					throw error;
				}
			};
		case "bidi_streaming":
			return async function* (
				requests: AsyncIterable<unknown>,
				context: HandlerContext,
			) {
				const call = callOf(context);
				try {
					for await (const response of run(
						tapIterable(requests, (m, i) => request(call, m, i === 0)),
						context,
					) as AsyncIterable<unknown>) {
						recorder.in(call, method, response);
						yield response;
					}
					recorder.status(call, method);
				} catch (error) {
					recorder.status(call, method, error);
					throw error;
				}
			};
	}
}
