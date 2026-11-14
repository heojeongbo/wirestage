import type { Frame, FrameFilter } from "../model/frame.js";

const ALWAYS = () => true;

/**
 * Compile a filter into one predicate. Queries run over every frame of a long
 * test, often in a polling loop, so the per-frame work is a handful of
 * comparisons and the `where` callback runs only after the cheap fields pass.
 */
export function compileFilter(
	filter: FrameFilter | undefined,
): (frame: Frame) => boolean {
	if (filter === undefined) return ALWAYS;
	const checks: ((frame: Frame) => boolean)[] = [];
	const { protocol, kind, endpoint, where } = filter;
	if (protocol !== undefined) {
		if (typeof protocol === "string")
			checks.push((f) => f.protocol === protocol);
		else {
			const set = new Set(protocol);
			checks.push((f) => set.has(f.protocol));
		}
	}
	if (kind !== undefined) {
		if (typeof kind === "string") checks.push((f) => f.kind === kind);
		else {
			const set = new Set(kind);
			checks.push((f) => set.has(f.kind));
		}
	}
	for (const key of [
		"direction",
		"source",
		"page",
		"context",
		"correlation",
	] as const) {
		const expected = filter[key];
		if (expected !== undefined) checks.push((f) => f[key] === expected);
	}
	if (endpoint !== undefined) {
		if (typeof endpoint === "string")
			checks.push((f) => f.endpoint === endpoint);
		else
			checks.push((f) => {
				endpoint.lastIndex = 0;
				return endpoint.test(f.endpoint);
			});
	}
	const after = filter.after;
	if (after !== undefined) checks.push((f) => f.seq > after);
	if (where !== undefined) checks.push(where);
	if (checks.length === 0) return ALWAYS;
	return (frame) => {
		for (const check of checks) if (!check(frame)) return false;
		return true;
	};
}
