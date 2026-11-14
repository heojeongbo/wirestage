import { toBase64 } from "../../../shared/lib/bytes/index.js";
import type {
	Frame,
	SnapshotFrame,
	SnapshotOptions,
	TimelineSnapshot,
} from "../model/frame.js";

/**
 * A JSON-safe copy of `frames`, with payloads cut at `maxBytes` and, given a
 * `limit`, only the newest frames kept: a report is read from its end.
 */
export function snapshotFrames(
	frames: readonly Frame[],
	evicted: number,
	options: SnapshotOptions = {},
): TimelineSnapshot {
	const maxBytes = options.maxBytes ?? 4096;
	const kept =
		options.limit === undefined || frames.length <= options.limit
			? frames
			: frames.slice(frames.length - options.limit);
	return {
		evicted,
		omitted: frames.length - kept.length,
		frames: kept.map((frame): SnapshotFrame => {
			const base: SnapshotFrame = {
				seq: frame.seq,
				at: frame.at,
				protocol: frame.protocol,
				kind: frame.kind,
				direction: frame.direction,
				endpoint: frame.endpoint,
				source: frame.source,
				...(frame.page === undefined ? {} : { page: frame.page }),
				...(frame.context === undefined ? {} : { context: frame.context }),
				...(frame.correlation === undefined
					? {}
					: { correlation: frame.correlation }),
				...(Object.keys(frame.meta).length === 0
					? {}
					: { meta: jsonSafe(frame.meta) }),
			};
			if (frame.payload.empty) return base;
			const bytes = frame.payload.bytes();
			return {
				...base,
				size: bytes.byteLength,
				data: toBase64(bytes.subarray(0, maxBytes)),
				...(bytes.byteLength > maxBytes ? { truncated: true } : {}),
			};
		}),
	};
}

/**
 * One line per frame: `#12  +3.2ms  connect  out request  pkg.Svc/Method  42B`.
 * Times are relative to the first frame listed, which is what a reader of a
 * failure report compares.
 */
export function formatFrames(
	frames: readonly Frame[],
	options: { readonly limit?: number } = {},
): string {
	const limit = options.limit ?? 200;
	// Not `slice(-limit)`: a limit of 0 would be `slice(-0)`, every frame.
	const shown =
		frames.length > limit ? frames.slice(frames.length - limit) : frames;
	const origin = shown[0]?.at ?? 0;
	const lines = shown.map((frame) => {
		const size = frame.payload.empty
			? ""
			: `  ${frame.payload.bytes().byteLength}B`;
		const page = frame.page === undefined ? "" : `  ${frame.page}`;
		return `#${frame.seq}  +${(frame.at - origin).toFixed(1)}ms  ${frame.protocol}  ${frame.direction} ${frame.kind}  ${frame.endpoint}${page}${size}`;
	});
	if (frames.length > limit)
		lines.unshift(`… ${frames.length - limit} earlier frames not shown`);
	return lines.join("\n");
}

/**
 * Make `meta` survive `JSON.stringify`: a bigint (protobuf int64) or a cycle
 * would otherwise throw while writing the report — at the exact moment a test
 * has already failed and the report is the only evidence.
 */
function jsonSafe(
	meta: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	// The objects on the path from the root to the value being written. Only
	// those make a cycle: an object met again elsewhere is merely shared.
	const ancestors: object[] = [];
	return JSON.parse(
		JSON.stringify(meta, function (this: unknown, _key, value: unknown) {
			if (typeof value === "bigint") return value.toString();
			if (value instanceof Uint8Array) return toBase64(value);
			if (typeof value !== "object" || value === null) return value;
			// `this` holds `value`: whatever was above it is finished.
			while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
			if (ancestors.includes(value)) return "[circular]";
			ancestors.push(value);
			return value;
		}),
	) as Record<string, unknown>;
}
