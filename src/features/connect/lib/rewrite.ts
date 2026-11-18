import {
	clone,
	create,
	type DescMessage,
	type DescMethodServerStreaming,
	type DescMethodUnary,
	isMessage,
	type MessageShape,
} from "@bufbuild/protobuf";

import type { RequestEdit, StubHandle, StubOptions } from "../model/types.js";
import { endpointOf, type Recorder } from "./recorder.js";
import type { RpcRules } from "./rules.js";
import { handleOf } from "./stubs.js";

/**
 * Send calls on to the real backend with the request the test rewrote,
 * encoded as the page encoded its own. The page's request is on the timeline
 * as the page sent it, the rewrite beside it, and the backend's answer after:
 * the call stays the page's, with what the test changed in plain view.
 */
export async function stubRewrite<I extends DescMessage, O extends DescMessage>(
	rules: RpcRules,
	recorder: Recorder,
	method: DescMethodUnary<I, O> | DescMethodServerStreaming<I, O>,
	edit: RequestEdit<I>,
	options: StubOptions<I>,
): Promise<StubHandle> {
	return handleOf(
		await rules.add({
			method,
			label: `rewrite ${endpointOf(method)}`,
			options,
			observe: true,
			respond(view, [request]) {
				// A request that would not decode has nothing to rewrite.
				if (request === undefined) return { type: "fallback" };
				// A copy, so the request already on the timeline stays the page's.
				const copy = clone(method.input, request as MessageShape<I>);
				const edited = edit(copy, view);
				const sent = isMessage(edited, method.input)
					? edited
					: create(method.input, edited);
				recorder.forwarded(rules.callOf(view), method, sent);
				return rules.forward(method, view, sent);
			},
		}),
	);
}
