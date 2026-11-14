import type {
	Frame,
	FrameFilter,
	Timeline,
} from "../../../entities/frame/index.js";
import type { WaitForOptions } from "../../../entities/plugin/index.js";
import type { PagePort } from "../../../shared/api/playwright/index.js";
import type { Clock } from "../../../shared/lib/clock/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type { StageCore } from "../model/stage.js";

export interface ReadsDeps {
	readonly timeline: Timeline;
	readonly clock: Clock;
	/** Flush every page buffer into the timeline. */
	readonly sync: () => Promise<void>;
	/** The id frames use for a page. */
	readonly pageId: (page: PagePort) => string;
	/** Defaults for `waitFor`, in milliseconds. */
	readonly wait: { readonly timeout: number; readonly interval: number };
}

/**
 * Frames a report holds unless asked otherwise. A report is read from its
 * end, and an unbounded one grows with the test: a long run would attach
 * tens of megabytes, or fail to serialize at all.
 */
const REPORT_LIMIT = 1_000;

export type StageReads = Pick<
	StageCore,
	| "frames"
	| "drain"
	| "mark"
	| "cursor"
	| "since"
	| "between"
	| "waitFor"
	| "report"
>;

/**
 * The stage's reads of its timeline. Every one flushes the page buffers
 * first: that flush is what makes arrival order the order things happened in.
 */
export function createReads(deps: ReadsDeps): StageReads {
	const { timeline, clock, sync } = deps;
	const drainCursor = timeline.cursor();

	const requireMarker = (name: string): Frame => {
		const marker = timeline.marker(name);
		if (marker === undefined)
			throw new WirestageError(
				"INVALID_ARGUMENT",
				timeline.evicted > 0
					? `no marker "${name}" on the timeline: it was never placed, or it was among the ${timeline.evicted} frame(s) dropped at capacity`
					: `no marker "${name}" on the timeline; place one with stage.mark("${name}")`,
			);
		return marker;
	};

	return {
		async frames(filter) {
			await sync();
			return timeline.frames(filter);
		},
		async drain(filter) {
			await sync();
			return drainCursor.take(filter);
		},
		async mark(name, options = {}) {
			await sync();
			const { page, meta } = options;
			return timeline.append({
				protocol: "wirestage",
				kind: "marker",
				direction: "none",
				endpoint: name,
				source: "test",
				...(page === undefined
					? {}
					: { page: typeof page === "string" ? page : deps.pageId(page) }),
				...(meta === undefined ? {} : { meta }),
			});
		},
		cursor(base = {}) {
			let position = 0;
			const read = async (filter: FrameFilter) => {
				await sync();
				const where = filter.where;
				return timeline.frames({
					...base,
					...filter,
					after: Math.max(position, base.after ?? 0, filter.after ?? 0),
					where: (frame) =>
						(base.where === undefined || base.where(frame)) &&
						(where === undefined || where(frame)),
				});
			};
			return {
				async take(filter = {}) {
					const frames = await read(filter);
					// Past everything that arrived, not just what matched: the next
					// take starts where this one looked.
					position = Math.max(position, timeline.last()?.seq ?? 0);
					return frames;
				},
				peek: (filter = {}) => read(filter),
				get position() {
					return position;
				},
			};
		},
		async since(marker, filter) {
			await sync();
			const after = requireMarker(marker).seq;
			return timeline.frames({
				...filter,
				after: Math.max(after, filter?.after ?? 0),
			});
		},
		async between(from, to, filter) {
			await sync();
			const start = requireMarker(from).seq;
			const end = requireMarker(to).seq;
			const where = filter?.where;
			return timeline.frames({
				...filter,
				after: Math.max(start, filter?.after ?? 0),
				where: (frame) =>
					frame.seq < end && (where === undefined || where(frame)),
			});
		},
		async waitFor(filter: FrameFilter, options: WaitForOptions = {}) {
			const count = options.count ?? 1;
			const timeout = options.timeout ?? deps.wait.timeout;
			const interval = options.interval ?? deps.wait.interval;
			const deadline = clock.now() + timeout;
			for (;;) {
				await sync();
				const found = timeline.frames(filter);
				if (found.length >= count) return found;
				const remaining = deadline - clock.now();
				if (remaining <= 0)
					throw new WirestageError(
						"TIMEOUT",
						`waited ${timeout} ms for ${count} frame(s) matching ${describeFilter(filter)}; ${found.length} matched. Last frames:\n${timeline.format(undefined, { limit: 20 })}`,
						{ details: { count, matched: found.length, timeout } },
					);
				await clock.sleep(Math.min(interval, remaining));
			}
		},
		report(filter, options = {}) {
			const limit = options.limit ?? REPORT_LIMIT;
			return {
				snapshot: timeline.snapshot(filter, { limit }),
				text: timeline.format(filter, { limit }),
			};
		},
	};
}

/** A filter as JSON, with RegExps and callbacks spelled out instead of lost. */
function describeFilter(filter: FrameFilter): string {
	return JSON.stringify(filter, (_key, value: unknown) => {
		if (value instanceof RegExp) return value.toString();
		if (typeof value === "function") return "[function]";
		return value;
	});
}
