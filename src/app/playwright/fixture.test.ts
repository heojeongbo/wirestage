import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeContext } from "../../__fixtures__/fake-playwright.js";
import { definePlugin } from "../../entities/plugin/index.js";
import {
	getLogThreshold,
	setLogThreshold,
} from "../../shared/lib/logger/index.js";
import type { Stage } from "../../widgets/stage/index.js";
import { createStageFixture, type StageTestInfo, withStage } from "./index.js";

afterEach(() => {
	setLogThreshold("warn");
	vi.restoreAllMocks();
});

const marker = definePlugin({
	name: "marker",
	setup: () => ({ api: { ok: true } }),
});

function testInfo(status: string, expectedStatus = "passed") {
	const attachments: { name: string; body: string; contentType: string }[] = [];
	const info: StageTestInfo & { attachments: typeof attachments } = {
		status,
		expectedStatus,
		attachments,
		async attach(name, options) {
			attachments.push({ name, ...options });
		},
	};
	return info;
}

describe("stage fixture", () => {
	it("gives the test an attached stage and disposes it afterwards", async () => {
		const fixture = createStageFixture({ plugins: [marker] }, {});
		const context = createFakeContext();
		let seen: Stage<readonly [typeof marker]> | undefined;
		const info = testInfo("passed");
		await fixture(
			{ context, baseURL: "http://app.test" },
			async (stage) => {
				seen = stage;
				expect(stage.attachments.map((a) => a.baseURL)).toEqual([
					"http://app.test",
				]);
				expect(stage.marker.ok).toBe(true);
			},
			info,
		);
		expect(seen?.disposed).toBe(true);
		// A passing test gets no report by default.
		expect(info.attachments).toEqual([]);
	});

	it("attaches the timeline when the test failed", async () => {
		const fixture = createStageFixture({ plugins: [] }, {});
		const info = testInfo("failed");
		await fixture(
			{ context: createFakeContext(), baseURL: undefined },
			async (stage) => {
				await stage.mark("before the failure");
			},
			info,
		);
		expect(info.attachments.map((a) => [a.name, a.contentType])).toEqual([
			["wirestage-timeline.txt", "text/plain"],
			["wirestage-timeline.json", "application/json"],
		]);
		expect(info.attachments[0]?.body).toContain("before the failure");
		expect(JSON.parse(info.attachments[1]?.body ?? "{}").frames).toHaveLength(
			1,
		);
	});

	it("reports always or never as configured, with the environment winning", async () => {
		const run = async (
			options: Parameters<typeof createStageFixture>[0],
			env: Record<string, string>,
			status: string,
		) => {
			const info = testInfo(status);
			await createStageFixture(options, env)(
				{ context: createFakeContext(), baseURL: undefined },
				async (stage) => {
					await stage.mark("something happened");
				},
				info,
			);
			return info.attachments.length;
		};
		expect(await run({ plugins: [], report: "always" }, {}, "passed")).toBe(2);
		expect(await run({ plugins: [], report: "never" }, {}, "failed")).toBe(0);
		expect(
			await run(
				{ plugins: [], report: "never" },
				{ WIRESTAGE_REPORT: " Always " },
				"passed",
			),
		).toBe(2);
	});

	it("ignores an environment value it cannot use, saying so once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fixture = createStageFixture(
			{ plugins: [], log: "warn" },
			{ WIRESTAGE_REPORT: "sometimes", WIRESTAGE_LOG: "chatty" },
		);
		// One warning each, when the fixture is made — not one per test.
		expect(warn).toHaveBeenCalledTimes(2);
		const messages = warn.mock.calls.map((call) => String(call[3]));
		expect(messages).toEqual([
			"ignoring an unknown WIRESTAGE_REPORT",
			"ignoring an unknown WIRESTAGE_LOG",
		]);
		expect(getLogThreshold()).toBe("warn");
		// Neither obeyed nor fatal: the default report mode still applies.
		for (const status of ["failed", "failed"]) {
			const info = testInfo(status);
			await fixture(
				{ context: createFakeContext(), baseURL: undefined },
				async (stage) => {
					await stage.mark("something happened");
				},
				info,
			);
			expect(info.attachments).toHaveLength(2);
		}
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("flushes the pages before reporting, so the last frames are in it", async () => {
		const recorded = definePlugin({
			name: "recorded",
			setup(context) {
				context.pages.register({
					id: "recorded",
					install: function install(env) {
						env.onCommand("emit", () => {
							env.emit({ type: "first", at: 0 });
							env.emit({ type: "held", at: 0 });
						});
					},
					config: null,
					state: () => null,
					receive(entries, origin) {
						for (const entry of entries)
							context.timeline.append({
								protocol: "recorded",
								kind: "message",
								direction: "out",
								endpoint: entry.type,
								source: "page",
								page: origin.page,
							});
					},
				});
				return {
					api: { emit: () => context.pages.command("recorded", "emit") },
				};
			},
		});
		const fixture = createStageFixture(
			{ plugins: [recorded], pageFlushMs: 60_000 },
			{},
		);
		const context = createFakeContext();
		const info = testInfo("failed");
		await fixture(
			{ context, baseURL: undefined },
			async (stage) => {
				context.newPage().load();
				// The page records two entries; the second waits in its buffer
				// when the test fails right after.
				await stage.recorded.emit();
			},
			info,
		);
		const snapshot = JSON.parse(info.attachments[1]?.body ?? "{}") as {
			frames: { endpoint: string }[];
		};
		expect(snapshot.frames.map((f) => f.endpoint)).toEqual(["first", "held"]);
	});

	it("keeps a report to its newest frames", async () => {
		const run = async (reportLimit?: number) => {
			const info = testInfo("failed");
			await createStageFixture(
				{
					plugins: [],
					...(reportLimit === undefined ? {} : { reportLimit }),
				},
				{},
			)(
				{ context: createFakeContext(), baseURL: undefined },
				async (stage) => {
					for (let i = 0; i < 1_050; i++) await stage.mark(`m${i}`);
				},
				info,
			);
			const snapshot = JSON.parse(info.attachments[1]?.body ?? "{}") as {
				frames: { endpoint: string }[];
				omitted: number;
			};
			return {
				frames: snapshot.frames.length,
				omitted: snapshot.omitted,
				last: snapshot.frames.at(-1)?.endpoint,
			};
		};
		// A long run must not attach megabytes: the newest thousand by default.
		expect(await run()).toEqual({ frames: 1_000, omitted: 50, last: "m1049" });
		expect(await run(10)).toEqual({
			frames: 10,
			omitted: 1_040,
			last: "m1049",
		});
	});

	it("disposes the stage even when the report cannot be written", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const info = testInfo("failed");
		info.attach = async () => {
			throw new Error("the reporter is gone");
		};
		let stage: Stage | undefined;
		await createStageFixture({ plugins: [] }, {})(
			{ context: createFakeContext(), baseURL: undefined },
			async (s) => {
				stage = s;
				await s.mark("x");
			},
			info,
		);
		// The report is a courtesy: its failure is logged, not thrown over the
		// test's own result, and the stage is still let go.
		expect(stage?.disposed).toBe(true);
		expect(warn).toHaveBeenCalled();
	});

	it("disposes the stage when attaching the context fails", async () => {
		const failing = definePlugin({
			name: "failing",
			setup: () => ({
				api: {},
				attach: () => {
					throw new Error("cannot attach");
				},
				dispose: () => {
					disposed = true;
				},
			}),
		});
		let disposed = false;
		const use = vi.fn();
		await expect(
			createStageFixture({ plugins: [failing] }, {})(
				{ context: createFakeContext(), baseURL: undefined },
				use,
				testInfo("failed"),
			),
		).rejects.toThrow("cannot attach");
		expect(use).not.toHaveBeenCalled();
		expect(disposed).toBe(true);
	});

	it("attaches nothing for an empty timeline, even when the test failed", async () => {
		const info = testInfo("failed");
		await createStageFixture({ plugins: [], report: "always" }, {})(
			{ context: createFakeContext(), baseURL: undefined },
			async () => {},
			info,
		);
		expect(info.attachments).toEqual([]);
	});

	it("disposes the stage even when the test throws", async () => {
		const fixture = createStageFixture({ plugins: [] }, {});
		let stage: Stage | undefined;
		await expect(
			fixture(
				{ context: createFakeContext(), baseURL: undefined },
				async (s) => {
					stage = s;
					throw new Error("test body failed");
				},
				testInfo("failed"),
			),
		).rejects.toThrow("test body failed");
		expect(stage?.disposed).toBe(true);
	});

	it("sets the log threshold from the option or WIRESTAGE_LOG", () => {
		createStageFixture({ plugins: [], log: "info" }, {});
		expect(getLogThreshold()).toBe("info");
		createStageFixture(
			{ plugins: [], log: "info" },
			{ WIRESTAGE_LOG: "debug" },
		);
		expect(getLogThreshold()).toBe("debug");
		// With neither, whatever was set before stands.
		setLogThreshold("error");
		createStageFixture({ plugins: [] }, {});
		expect(getLogThreshold()).toBe("error");
	});

	it("leaves attaching to the test with `attach: false`", async () => {
		const fixture = createStageFixture(
			{ plugins: [marker], attach: false },
			{},
		);
		let seen: Stage<readonly [typeof marker]> | undefined;
		await fixture(
			{ baseURL: "http://app.test" },
			async (stage) => {
				seen = stage;
				expect(stage.attachments).toEqual([]);
				await stage.attach(createFakeContext());
				expect(stage.attachments.map((a) => a.baseURL)).toEqual([
					"http://app.test",
				]);
			},
			testInfo("passed"),
		);
		// Disposing the stage detached what the test attached.
		expect(seen?.disposed).toBe(true);
		expect(seen?.attachments).toEqual([]);
	});

	it("reads the real process environment by default", () => {
		expect(() => createStageFixture({ plugins: [] })).not.toThrow();
	});
});

describe("withStage", () => {
	it("extends a test with a `stage` fixture whose dependencies Playwright can read", () => {
		const extend = vi.fn((fixtures: Record<string, unknown>) => ({
			extended: fixtures,
		}));
		const base = { extend } as unknown as Parameters<typeof withStage>[0];
		const extended = withStage(base, { plugins: [marker] }) as unknown as {
			extended: { stage: (...args: unknown[]) => unknown };
		};
		expect(extend).toHaveBeenCalledTimes(1);
		// Playwright parses the fixture's source for its dependencies: the first
		// parameter must stay an object pattern naming context and baseURL.
		expect(extended.extended.stage.toString()).toMatch(
			/^async \(\{ context, baseURL \}, use, testInfo\)/,
		);
	});

	it("does not name `context` when the test attaches its own", () => {
		const extend = vi.fn((fixtures: Record<string, unknown>) => ({
			extended: fixtures,
		}));
		const base = { extend } as unknown as Parameters<typeof withStage>[0];
		const extended = withStage(base, {
			plugins: [marker],
			attach: false,
		}) as unknown as { extended: { stage: (...args: unknown[]) => unknown } };
		// Naming it would make Playwright create a context nobody uses.
		expect(extended.extended.stage.toString()).toMatch(
			/^async \(\{ baseURL \}, use, testInfo\)/,
		);
	});
});
