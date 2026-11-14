import { bench, describe } from "vitest";

import { compileFilter } from "../src/entities/frame/index.js";
import {
	createManualClock,
	createTimeline,
	type Timeline,
} from "../src/index.js";

const clock = createManualClock();
const payload = new Uint8Array(64);

function filled(count: number): Timeline {
	const timeline = createTimeline({ clock, capacity: count + 1 });
	for (let i = 0; i < count; i++)
		timeline.append({
			protocol: i % 3 === 0 ? "webrtc" : "connect",
			kind: "message",
			direction: i % 2 === 0 ? "out" : "in",
			endpoint: i % 5 === 0 ? "room/cursor" : "pkg.Svc/Watch",
			source: "page",
			data: payload,
		});
	return timeline;
}

describe("timeline append", () => {
	const timeline = createTimeline({ clock, capacity: 50_000 });
	// At capacity, appends also evict: the steady state of a long test.
	bench("append a 64-byte frame (with eviction)", () => {
		timeline.append({
			protocol: "webrtc",
			kind: "message",
			direction: "out",
			endpoint: "room/cursor",
			source: "page",
			data: payload,
		});
	});
	bench("append with a lazy payload", () => {
		timeline.append({
			protocol: "connect",
			kind: "message",
			direction: "in",
			endpoint: "pkg.Svc/Watch",
			source: "stub",
			data: () => payload,
		});
	});
});

describe("timeline query (10,000 frames)", () => {
	const timeline = filled(10_000);
	const filter = {
		protocol: "webrtc",
		endpoint: "room/cursor",
		direction: "out",
	} as const;
	const predicate = compileFilter(filter);
	bench("frames(filter)", () => {
		timeline.frames(filter);
	});
	bench("precompiled predicate over all frames", () => {
		timeline.frames().filter(predicate);
	});
	bench("last(filter)", () => {
		timeline.last({ endpoint: "room/cursor" });
	});
	bench("cursor take after 100 new frames", () => {
		const cursor = timeline.cursor();
		for (let i = 0; i < 100; i++)
			timeline.append({
				protocol: "x",
				kind: "event",
				direction: "in",
				endpoint: "e",
				source: "stub",
			});
		cursor.take({ protocol: "x" });
	});
});
