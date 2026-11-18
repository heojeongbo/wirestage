import type { DescMessage, DescMethod } from "@bufbuild/protobuf";

import type { Frame, Timeline } from "../../../entities/frame/index.js";
import {
	type Arrivals,
	createArrivals,
} from "../../../shared/lib/async/index.js";
import type { Clock } from "../../../shared/lib/clock/index.js";
import type { PendingCall, RpcCall } from "../model/types.js";
import { assembleCalls } from "./calls.js";
import { endpointOf } from "./recorder.js";

export interface CallArrivals {
	next<I extends DescMessage, O extends DescMessage>(
		method: DescMethod & { readonly input: I; readonly output: O },
		options: { readonly timeout?: number },
	): Promise<PendingCall<I, O>>;
	/** Stop following the timeline. */
	dispose(): void;
}

/**
 * Calls as their requests land on the timeline, one queue per method, for
 * `nextCall()`. It reads the timeline, not a rule: a call counts whichever
 * rule recorded it, and wherever that rule sits among the others.
 */
export function createCallArrivals(
	timeline: Timeline,
	clock: Clock,
	protocol: string,
): CallArrivals {
	const queues = new Map<string, Arrivals<Frame>>();
	const unsubscribes: (() => void)[] = [];

	const opens = (frame: Frame, endpoint: string) =>
		frame.protocol === protocol &&
		frame.endpoint === endpoint &&
		frame.kind === "request";

	const queueOf = (endpoint: string): Arrivals<Frame> => {
		const known = queues.get(endpoint);
		if (known !== undefined) return known;
		const queue = createArrivals<Frame>({ clock, label: `${endpoint} call` });
		// Calls made before the first ask count: a test that asks once the page
		// has loaded must not miss the call the load made.
		for (const frame of timeline.frames({
			protocol,
			endpoint,
			kind: "request",
		}))
			queue.push(frame);
		unsubscribes.push(
			timeline.subscribe((frame) => {
				if (opens(frame, endpoint)) queue.push(frame);
			}),
		);
		queues.set(endpoint, queue);
		return queue;
	};

	/** The call's frames as one call. Connect's own frames all carry a correlation. */
	const callOf = <I extends DescMessage, O extends DescMessage>(
		endpoint: string,
		correlation: string,
	) =>
		assembleCalls<I, O>(
			timeline.frames({ protocol, endpoint, correlation }),
		)[0] as RpcCall<I, O>;

	const settle = async <I extends DescMessage, O extends DescMessage>(
		endpoint: string,
		correlation: string,
		timeout: number | undefined,
	): Promise<RpcCall<I, O>> => {
		const ends = (frame: Frame) =>
			frame.protocol === protocol &&
			frame.endpoint === endpoint &&
			frame.correlation === correlation &&
			(frame.kind === "response" || frame.kind === "fault");
		const ending = createArrivals<Frame>({
			clock,
			label: `the end of ${endpoint} call ${correlation}`,
		});
		const unsubscribe = timeline.subscribe((frame) => {
			if (ends(frame)) ending.push(frame);
		});
		try {
			const already = timeline.last({ protocol, endpoint, correlation });
			if (already !== undefined && ends(already)) ending.push(already);
			await ending.next(timeout === undefined ? {} : { timeout });
		} finally {
			unsubscribe();
		}
		return callOf<I, O>(endpoint, correlation);
	};

	return {
		async next<I extends DescMessage, O extends DescMessage>(
			method: DescMethod & { readonly input: I; readonly output: O },
			options: { readonly timeout?: number },
		): Promise<PendingCall<I, O>> {
			const endpoint = endpointOf(method);
			const opening = await queueOf(endpoint).next(options);
			const correlation = opening.correlation as string;
			const [found] = assembleCalls<I, O>([opening]);
			const call = found as RpcCall<I, O>;
			return {
				correlation,
				// A request frame is the caller's, decoded or not.
				caller: opening.source,
				page: call.page,
				context: call.context,
				protocol: call.protocol,
				request: call.request,
				requestHeaders: call.requestHeaders,
				settled: (settleOptions = {}) =>
					settle<I, O>(endpoint, correlation, settleOptions.timeout),
			};
		},
		dispose() {
			for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
			queues.clear();
		},
	};
}
