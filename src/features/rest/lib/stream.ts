import type { FrameInit } from "../../../entities/frame/index.js";
import type { ResponseStream } from "../../../entities/plugin/index.js";
import type { RestReply } from "../model/types.js";

export type StreamReply = Extract<RestReply, { readonly kind: "stream" }>;

/**
 * Carry a `stream()` reply out on the open response that holds it, a page's
 * or a served fake's: the head at once, on the timeline as the exchange's
 * `response`, then each chunk the reply writes as a `message`. `record`
 * completes a frame with whose exchange it is.
 */
export async function openStream(
	reply: StreamReply,
	response: Omit<ResponseStream, "requestHeaders">,
	record: (frame: Pick<FrameInit, "kind" | "data" | "meta">) => void,
): Promise<void> {
	response.head(reply.status, reply.headers);
	// A client waits for the head: a watch is open once it has one.
	response.flush();
	record({
		kind: "response",
		meta: { status: reply.status, headers: reply.headers },
	});
	await reply.open({
		async write(chunk) {
			await response.write(chunk);
			record({ kind: "message", data: chunk });
		},
		end: () => response.end(),
		async cut() {
			response.cut();
			// Whoever holds the response records the cut before `closed` resolves.
			await response.closed;
		},
		closed: response.closed,
	});
}
