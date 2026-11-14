import type {
	Direction,
	FrameKind,
	FrameSource,
} from "../../../entities/frame/index.js";
import type {
	PluginContext,
	SocketView,
} from "../../../entities/plugin/index.js";
import { toBytes, utf8 } from "../../../shared/lib/bytes/index.js";
import type { WsData, WsMessage } from "../model/types.js";

/** What a test passes to `send`, as the wire carries it. */
export function encodeOutgoing(data: WsData): string | Uint8Array {
	if (typeof data === "string") return data;
	// Any binary form goes out as bytes; only what is left is a value.
	if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
		return toBytes(data);
	return JSON.stringify(data);
}

export function toMessage(
	direction: "in" | "out",
	raw: string | Uint8Array,
	at: number,
): WsMessage {
	const text = () => (typeof raw === "string" ? raw : utf8(raw));
	return {
		direction,
		data: raw,
		at,
		text,
		json: <T>() => JSON.parse(text()) as T,
	};
}

/** Writes one connection's frames: same endpoint, correlation and context. */
export type SocketLog = (
	kind: FrameKind,
	direction: Direction,
	source: FrameSource,
	meta: Readonly<Record<string, unknown>>,
	data?: string | Uint8Array,
) => void;

export function createSocketLog(
	context: Pick<PluginContext, "timeline">,
	protocol: string,
	socket: SocketView,
): SocketLog {
	return (kind, direction, source, meta, data) => {
		context.timeline.append({
			protocol,
			kind,
			direction,
			// The path, like every HTTP frame: it reads the same on the dev
			// server, the preview build and CI, whose origins all differ.
			endpoint: socket.url.pathname,
			source,
			correlation: socket.correlation,
			context: socket.context,
			meta,
			...(data === undefined ? {} : { data }),
		});
	};
}
