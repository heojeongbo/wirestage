import type {
	Direction,
	FrameInit,
	FrameKind,
	FrameSource,
} from "../../../entities/frame/index.js";
import type { PageEntry, PageSource } from "../../../entities/plugin/index.js";
import { fromBase64 } from "../../../shared/lib/bytes/index.js";

interface Shape {
	readonly kind: FrameKind;
	readonly direction: Direction;
	/** Who produced it: the app, the peer, or the stub that dropped it. */
	readonly source: FrameSource;
}

/** Page entry types, as the page module emits them. */
const SHAPES: Readonly<Record<string, Shape>> = {
	out: { kind: "message", direction: "out", source: "page" },
	in: { kind: "message", direction: "in", source: "network" },
	open: { kind: "lifecycle", direction: "none", source: "page" },
	close: { kind: "lifecycle", direction: "none", source: "page" },
	suppressed: { kind: "fault", direction: "in", source: "stub" },
	blocked: { kind: "fault", direction: "out", source: "stub" },
};

/** An entry type nobody declared: the page runtime's own `error`. */
const BROKEN: Shape = { kind: "fault", direction: "none", source: "page" };

/**
 * One page entry as a frame. A lifecycle frame says which `event` it was, a
 * fault says its `reason`, as every protocol's do, and an unknown type (the
 * runtime's own `error`) still lands as a fault instead of vanishing.
 */
export function toFrame(
	protocol: string,
	entry: PageEntry,
	origin: PageSource,
): FrameInit {
	const shape = SHAPES[entry.type] ?? BROKEN;
	const label = entry.meta?.["label"];
	return {
		protocol,
		kind: shape.kind,
		direction: shape.direction,
		endpoint: typeof label === "string" ? label : "",
		// A message the test injected is the test's, not the peer's.
		source: entry.meta?.["injected"] === true ? "test" : shape.source,
		at: entry.at,
		...(entry.data === undefined
			? entry.text === undefined
				? {}
				: { data: entry.text }
			: { data: fromBase64(entry.data) }),
		meta: {
			...entry.meta,
			...(shape.kind === "lifecycle" ? { event: entry.type } : {}),
			...(shape.kind === "fault" ? { reason: entry.type } : {}),
		},
		page: origin.page,
		context: origin.context,
	};
}
