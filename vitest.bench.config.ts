import { defineConfig } from "vitest/config";

/**
 * Micro-benchmarks for the hot paths: every recorded message goes through
 * the timeline, the envelope codec or the matchers. `pnpm bench` prints
 * tinybench statistics; `pnpm perf` is the budgeted, end-to-end measurement.
 */
export default defineConfig({
	test: {
		benchmark: {
			include: ["bench/**/*.bench.ts"],
			outputJson: "bench-results.json",
		},
	},
});
