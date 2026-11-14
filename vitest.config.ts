import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
					environment: "node",
				},
			},
			{
				// Real browsers through the Playwright library. They prove the
				// adapters against Chromium; coverage does NOT depend on them, so
				// `pnpm test:coverage` stays green on a machine without browsers.
				test: {
					name: "browser",
					include: ["tests/browser/**/*.test.ts"],
					environment: "node",
					testTimeout: 30_000,
					hookTimeout: 60_000,
					fileParallelism: false,
				},
			},
		],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/__fixtures__/**"],
			reporter: ["text", "html", "json-summary"],
			thresholds: {
				perFile: true,
				statements: 100,
				branches: 100,
				functions: 100,
				lines: 100,
			},
		},
	},
});
