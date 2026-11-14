import type { TestType } from "@playwright/test";

import type { AnyWirePlugin } from "../../../entities/plugin/index.js";
import type { ContextPort } from "../../../shared/api/playwright/index.js";
import {
	createScopedLogger,
	type LogThreshold,
	parseLogThreshold,
	setLogThreshold,
} from "../../../shared/lib/logger/index.js";
import {
	createStage,
	type Stage,
	type StageOptions,
} from "../../../widgets/stage/index.js";

/** When the timeline is attached to the test report. */
export type ReportMode = "on-failure" | "always" | "never";

export interface StageFixtureOptions<Plugins extends readonly AnyWirePlugin[]>
	extends Omit<StageOptions<Plugins>, "baseURL" | "clock"> {
	/**
	 * Default `on-failure`. `WIRESTAGE_REPORT` overrides it. An empty timeline
	 * is never attached.
	 */
	readonly report?: ReportMode;
	/**
	 * Frames a report holds, counting back from the newest. Default 1,000: a
	 * report is read from its end, and one that grows with the test would
	 * attach tens of megabytes to a long run.
	 */
	readonly reportLimit?: number;
	/** Default `warn`. `WIRESTAGE_LOG` overrides it. */
	readonly log?: LogThreshold;
	/**
	 * Attach the test's `context` before the body runs. Default true. Turn it
	 * off when tests open their own contexts (`browser.newContext()`, two users
	 * at once): the fixture then never asks Playwright for `context`, so no
	 * unused one is created, and the test attaches what it opens.
	 */
	readonly attach?: boolean;
}

export interface StageFixtureArgs {
	/** Absent when the fixture does not attach (`attach: false`). */
	readonly context?: ContextPort;
	readonly baseURL: string | undefined;
}

/** The part of Playwright's TestInfo the fixture uses. */
export interface StageTestInfo {
	readonly status?: string;
	readonly expectedStatus: string;
	attach(
		name: string,
		options: { readonly body: string; readonly contentType: string },
	): Promise<void>;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPORT_MODES: readonly ReportMode[] = ["on-failure", "always", "never"];

/**
 * The environment's say, read once when the fixture is made. A value it
 * cannot use is ignored with one warning: a typo in CI config must neither
 * turn reports off silently nor fail every test, and saying so once is
 * enough.
 */
function readEnvironment(env: Environment): {
	readonly report: ReportMode | undefined;
	readonly log: LogThreshold | undefined;
} {
	const warn = (name: string, value: string, allowed: readonly string[]) =>
		createScopedLogger("Fixture").warn(`ignoring an unknown ${name}`, {
			value,
			allowed,
		});
	const wantedReport = env["WIRESTAGE_REPORT"]?.trim().toLowerCase();
	const report = REPORT_MODES.find((mode) => mode === wantedReport);
	if (wantedReport !== undefined && report === undefined)
		warn("WIRESTAGE_REPORT", wantedReport, REPORT_MODES);
	const wantedLog = env["WIRESTAGE_LOG"];
	const log = parseLogThreshold(wantedLog);
	if (wantedLog !== undefined && log === undefined)
		warn("WIRESTAGE_LOG", wantedLog, [
			"debug",
			"log",
			"info",
			"warn",
			"error",
			"silent",
		]);
	return { report, log };
}

/**
 * The `stage` fixture as a plain function, so it can be tested without the
 * Playwright runner: one stage per test, attached to the test's context
 * before the test body runs, reported on failure, disposed afterwards.
 */
export function createStageFixture<
	const Plugins extends readonly AnyWirePlugin[],
>(
	options: StageFixtureOptions<Plugins>,
	env: Environment = process.env,
): (
	args: StageFixtureArgs,
	use: (stage: Stage<Plugins>) => Promise<void>,
	testInfo: StageTestInfo,
) => Promise<void> {
	const { report, reportLimit, log, attach = true, ...stageOptions } = options;
	const fromEnv = readEnvironment(env);
	const threshold = fromEnv.log ?? log;
	if (threshold !== undefined) setLogThreshold(threshold);
	const mode = fromEnv.report ?? report ?? "on-failure";
	const fixtureLog = createScopedLogger("Fixture");

	/** Attach the timeline to the test's report, when there is one to read. */
	const attachReport = async (
		stage: Stage<Plugins>,
		testInfo: StageTestInfo,
	): Promise<void> => {
		const failed = testInfo.status !== testInfo.expectedStatus;
		if (mode === "never" || (mode === "on-failure" && !failed)) return;
		// What the pages still hold is often the frame the failure is about.
		await stage.sync();
		// Nothing on the timeline is nothing to read: no empty attachment.
		if (stage.timeline.size === 0 && stage.timeline.evicted === 0) return;
		const { snapshot, text } = stage.report(
			undefined,
			reportLimit === undefined ? {} : { limit: reportLimit },
		);
		await testInfo.attach("wirestage-timeline.txt", {
			body: text,
			contentType: "text/plain",
		});
		await testInfo.attach("wirestage-timeline.json", {
			body: JSON.stringify(snapshot, null, 2),
			contentType: "application/json",
		});
	};

	const run = async (
		context: ContextPort | undefined,
		baseURL: string | undefined,
		use: (stage: Stage<Plugins>) => Promise<void>,
		testInfo: StageTestInfo,
	): Promise<void> => {
		const stage = createStage({
			...stageOptions,
			...(baseURL === undefined ? {} : { baseURL }),
		});
		try {
			if (context !== undefined) await stage.attach(context);
			await use(stage);
		} finally {
			try {
				await attachReport(stage, testInfo);
			} catch (error) {
				// The report is a courtesy; failing to write one must not hide
				// the test's own result, nor keep the stage from being disposed.
				fixtureLog.warn("could not attach the timeline", {}, error);
			} finally {
				await stage.dispose();
			}
		}
	};
	// Playwright reads a fixture's dependencies off its SOURCE, so each mode
	// is its own literal: naming `context` is what makes Playwright create one.
	return attach
		? async ({ context, baseURL }, use, testInfo) =>
				run(context, baseURL, use, testInfo)
		: async ({ baseURL }, use, testInfo) =>
				run(undefined, baseURL, use, testInfo);
}

/**
 * Extend a Playwright `test` with a `stage` fixture:
 *
 *     export const test = withStage(base, { plugins: [webrtc(), connect()] });
 *     test("...", async ({ page, stage }) => { ... });
 */
export function withStage<
	Args extends object,
	Workers extends object,
	const Plugins extends readonly AnyWirePlugin[],
>(
	test: TestType<Args, Workers>,
	options: StageFixtureOptions<Plugins>,
): TestType<Args & { stage: Stage<Plugins> }, Workers> {
	// Playwright reads a fixture's dependencies off the SOURCE of its first
	// parameter, so the fixture must be passed as written — with its
	// `({ context, baseURL }, use, testInfo)` destructuring — not wrapped. The
	// cast is only for the generic `extend` signature, which TypeScript cannot
	// resolve against an arbitrary `Args`.
	const extend = test.extend.bind(test) as unknown as (fixtures: {
		readonly stage: ReturnType<typeof createStageFixture<Plugins>>;
	}) => TestType<Args & { stage: Stage<Plugins> }, Workers>;
	return extend({ stage: createStageFixture(options) });
}
