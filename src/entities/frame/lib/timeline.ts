import type { Clock } from "../../../shared/lib/clock/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type {
	Frame,
	FrameFilter,
	FrameInit,
	Timeline,
	TimelineCursor,
} from "../model/frame.js";
import { compileFilter } from "./filter.js";
import { createPayload } from "./payload.js";
import { formatFrames, snapshotFrames } from "./snapshot.js";

export interface TimelineOptions {
	readonly clock: Clock;
	/**
	 * Frames kept before the oldest are dropped. A 60 Hz data channel makes
	 * 3,600 frames a minute; the default holds a long test without letting a
	 * soak run grow without bound.
	 */
	readonly capacity?: number;
	/**
	 * Told when a subscriber throws. By default the first such error is
	 * thrown to whoever appended the frame, once every subscriber has run.
	 */
	readonly onListenerError?: (error: unknown) => void;
}

const DEFAULT_CAPACITY = 100_000;

/**
 * The append-only log every protocol writes to. Order is arrival order (`seq`),
 * not timestamp order: the stage flushes page buffers before every read, so
 * arrival order is also the order things happened in.
 */
export function createTimeline(options: TimelineOptions): Timeline {
	const capacity = options.capacity ?? DEFAULT_CAPACITY;
	if (!Number.isInteger(capacity) || capacity < 1)
		throw new WirestageError(
			"INVALID_ARGUMENT",
			`timeline capacity must be a positive integer, got ${capacity}`,
		);
	let frames: Frame[] = [];
	let evicted = 0;
	let seq = 0;
	const listeners = new Set<(frame: Frame) => void>();

	const query = (filter: FrameFilter | undefined): Frame[] => {
		if (filter === undefined) return frames.slice();
		return frames.filter(compileFilter(filter));
	};

	/** Index of the first frame with `seq` greater than `position`. */
	const indexAfter = (position: number): number => {
		const first = frames[0];
		if (first === undefined) return 0;
		return Math.max(0, position - first.seq + 1);
	};

	return {
		append(init: FrameInit): Frame {
			const frame: Frame = {
				seq: ++seq,
				at: init.at ?? options.clock.now(),
				protocol: init.protocol,
				kind: init.kind,
				direction: init.direction,
				endpoint: init.endpoint,
				source: init.source,
				payload: createPayload(init.data),
				value: init.value,
				meta: init.meta ?? {},
				page: init.page,
				context: init.context,
				correlation: init.correlation,
			};
			frames.push(frame);
			if (frames.length > capacity) {
				// Drop a tenth at once: shifting one frame per append would make a
				// full timeline O(n) per frame.
				const drop = Math.max(1, Math.floor(capacity / 10));
				frames = frames.slice(drop);
				evicted += drop;
			}
			// The frame is on the timeline whatever a subscriber does with it,
			// and one that throws does not starve the rest.
			const failures: unknown[] = [];
			for (const listener of listeners) {
				try {
					listener(frame);
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) {
				if (options.onListenerError === undefined) throw failures[0];
				for (const failure of failures) options.onListenerError(failure);
			}
			return frame;
		},
		frames: query,
		last(filter) {
			const match = compileFilter(filter);
			return frames.findLast(match);
		},
		marker(name) {
			return frames.findLast((f) => f.kind === "marker" && f.endpoint === name);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		cursor(): TimelineCursor {
			let position = seq;
			return {
				take(filter) {
					const fresh = frames.slice(indexAfter(position));
					position = seq;
					return filter === undefined
						? fresh
						: fresh.filter(compileFilter(filter));
				},
				get position() {
					return position;
				},
			};
		},
		clear() {
			frames = [];
		},
		snapshot(filter, snapshotOptions) {
			return snapshotFrames(query(filter), evicted, snapshotOptions);
		},
		format(filter, formatOptions) {
			return formatFrames(query(filter), formatOptions);
		},
		get size() {
			return frames.length;
		},
		get evicted() {
			return evicted;
		},
		capacity,
	};
}
