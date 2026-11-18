import type { DescMessage, MessageShape } from "@bufbuild/protobuf";

import type { Frame } from "../../../entities/frame/index.js";
import type { RpcCall, RpcProtocol } from "../model/types.js";

/**
 * One method's frames as calls: one per correlation, oldest first. A frame
 * another writer left without a correlation is a call of its own.
 */
export function assembleCalls<I extends DescMessage, O extends DescMessage>(
	frames: readonly Frame[],
): RpcCall<I, O>[] {
	const byCall = new Map<string, Frame[]>();
	for (const frame of frames) {
		const key = frame.correlation ?? `#${frame.seq}`;
		const list = byCall.get(key) ?? [];
		list.push(frame);
		byCall.set(key, list);
	}
	return [...byCall].map(([correlation, own]) => {
		const first = own[0] as Frame;
		const rewritten = (frame: Frame) => frame.meta["rewrite"] === true;
		const requests = own.filter(
			(frame) =>
				frame.direction === "out" &&
				frame.value !== undefined &&
				!rewritten(frame),
		);
		const opening = own.find((frame) => frame.kind === "request");
		// Everything that is not the caller's is the answer: messages, the
		// status, or the fault that stood in for one.
		const answer = own.findLast((frame) => frame.direction !== "out");
		const status = own.findLast((frame) => frame.kind === "response");
		const fault = own.findLast((frame) => frame.kind === "fault");
		return {
			correlation,
			caller: requests[0]?.source,
			answeredBy: answer?.source,
			page: first.page,
			context: first.context,
			protocol: first.meta["rpcProtocol"] as RpcProtocol | undefined,
			request: requests[0]?.value as MessageShape<I> | undefined,
			requests: requests.map((frame) => frame.value as MessageShape<I>),
			requestHeaders: opening?.meta["headers"] as
				| Readonly<Record<string, string>>
				| undefined,
			forwarded: own.findLast(rewritten)?.value as MessageShape<I> | undefined,
			responses: own
				.filter(
					(frame) =>
						frame.direction === "in" &&
						frame.kind === "message" &&
						frame.value !== undefined,
				)
				.map((frame) => frame.value as MessageShape<O>),
			status:
				status === undefined
					? undefined
					: {
							code: Number(status.meta["code"]),
							message: String(status.meta["message"] ?? ""),
						},
			fault: fault === undefined ? undefined : String(fault.meta["reason"]),
			frames: own,
		};
	});
}
