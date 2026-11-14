import type {
	DescMessage,
	DescMethod,
	DescMethodServerStreaming,
	DescMethodUnary,
	MessageInitShape,
	MessageShape,
} from "@bufbuild/protobuf";

import type {
	AbortErrorCode,
	HttpOutcome,
	PluginContext,
} from "../../../entities/plugin/index.js";
import {
	createArrivals,
	createDeferred,
} from "../../../shared/lib/async/index.js";
import type {
	HeldCall,
	HoldOptions,
	HoldStub,
	StubHandle,
	StubOptions,
} from "../model/types.js";
import { endpointOf, type Recorder } from "./recorder.js";
import type { AnyImpl, RpcRules } from "./rules.js";
import { failingImpl, handleOf } from "./stubs.js";

/** Fail every call to a method at the network level. */
export async function stubAbort<I extends DescMessage>(
	rules: RpcRules,
	recorder: Recorder,
	method: DescMethod & { readonly input: I },
	options: StubOptions<I> & { readonly error?: AbortErrorCode },
): Promise<StubHandle> {
	const error = options.error ?? "failed";
	return handleOf(
		await rules.add({
			method,
			label: `abort ${endpointOf(method)}`,
			options,
			respond(view) {
				recorder.fault(rules.callOf(view), method, "abort", { error });
				return { type: "abort", error };
			},
		}),
	);
}

/**
 * Hold calls at the network boundary until the test decides each one. The
 * returned `abandon` lets go of whatever is still held, for the stage's
 * disposal: a route left undecided would keep its request open for good.
 */
export async function stubHold<I extends DescMessage, O extends DescMessage>(
	context: PluginContext,
	rules: RpcRules,
	recorder: Recorder,
	method: DescMethodUnary<I, O> | DescMethodServerStreaming<I, O>,
	options: HoldOptions<I>,
	pending: Set<() => void>,
): Promise<HoldStub<I, O>> {
	const calls = createArrivals<HeldCall<I, O>>({
		clock: context.clock,
		label: `${endpointOf(method)} held call`,
	});
	const rule = await rules.add({
		method,
		label: `hold ${endpointOf(method)}`,
		options,
		observe: true,
		async respond(view, [request]) {
			const decision =
				createDeferred<() => HttpOutcome | Promise<HttpOutcome>>();
			const carried = createDeferred<void>();
			/** The first decision stands; each resolves once it is carried out. */
			const decide = (make: () => HttpOutcome | Promise<HttpOutcome>) => {
				decision.resolve(make);
				return carried.promise;
			};
			const aborted = (error: AbortErrorCode) => () => {
				recorder.fault(rules.callOf(view), method, "abort", { error });
				return { type: "abort", error } as const;
			};
			const answered = (impl: AnyImpl) => () =>
				rules.answer(rules.handler(method, impl), method, view);
			const abandon = () => void decide(aborted("aborted"));
			pending.add(abandon);
			calls.push({
				request: request as MessageShape<I> | undefined,
				view,
				release: () => decide(() => ({ type: "fallback" })),
				reply: (message: MessageInitShape<O>) =>
					decide(
						answered(
							(method.methodKind === "server_streaming"
								? async function* () {
										yield message;
									}
								: async () => message) as AnyImpl,
						),
					),
				fail: (code, message) =>
					decide(answered(failingImpl(method, code, message))),
				abort: (error) => decide(aborted(error ?? "failed")),
			});
			try {
				return await (await decision.promise)();
			} finally {
				pending.delete(abandon);
				carried.resolve();
			}
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
		async releaseAll() {
			// Removed first: a call on its way in as this runs is not the
			// rule's any more, and goes straight on instead of being held.
			await rule.remove();
			await Promise.all(calls.items.map((call) => call.release()));
		},
	};
}
