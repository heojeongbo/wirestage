import { createLogger, type LogLevel } from "@heojeongbo/log-palette";

/**
 * The library's logging surface, and the only module that imports log-palette.
 *
 * The loggers are the library's own. log-palette also keeps a process-wide
 * registry (`getLogger`, `setGlobalLevel`, `disableAll`, `configure`) that an
 * app or a test suite using the same package shares; going through it would
 * let importing this library change the level of loggers that are not its
 * own, so nothing here touches it.
 *
 * Output goes to the test runner's stdout. Node ignores the `%c` styling
 * log-palette emits, so the badge reads as plain `[...Stage]` text there.
 */

/**
 * The stage's own subsystems, plus whatever scope a plugin brings. The
 * built-in names are spelled out so `"Http"` and `"HTTP"` cannot become two
 * badges for one subsystem; eight characters fit the badge column, and a
 * longer scope is cut to fit.
 */
export type LogScope =
	| "Stage"
	| "Http"
	| "Socket"
	| "Stream"
	| "Page"
	| "Connect"
	| "Rest"
	| "Sse"
	| "Ws"
	| "Rtc"
	| "Fixture"
	| "Plugin"
	| (string & {});

/** A level, or `silent` for no output at all. */
export type LogThreshold = LogLevel | "silent";

export type LogFields = Readonly<Record<string, unknown>>;

export interface ScopedLogger {
	debug(message: string, fields?: LogFields, error?: unknown): void;
	info(message: string, fields?: LogFields, error?: unknown): void;
	warn(message: string, fields?: LogFields, error?: unknown): void;
	error(message: string, fields?: LogFields, error?: unknown): void;
	/**
	 * Log without paying for `build` when the level would drop the line.
	 * log-palette checks the level inside its emit, so arguments are built
	 * even for a dropped `debug` — a frame dump on every request adds up.
	 */
	lazy(level: LogLevel, message: string, build: () => LogFields): void;
}

const RANK: Record<LogThreshold, number> = {
	debug: 0,
	log: 1,
	info: 2,
	warn: 3,
	error: 4,
	silent: 5,
};

type Palette = ReturnType<typeof createLogger>;

/** One logger per scope, so a scope's badge colour is stable. */
const loggers = new Map<string, Palette>();
let threshold: LogThreshold = "warn";

function apply(logger: Palette): void {
	logger.setEnabled(threshold !== "silent");
	if (threshold !== "silent") logger.setLevel(threshold);
}

/**
 * The default is `warn`: a test suite's output is for the test results, and
 * the library only speaks up when something is wrong. `WIRESTAGE_LOG=debug`
 * (read by the Playwright fixture) turns the rest on.
 */
export function setLogThreshold(next: LogThreshold): void {
	threshold = next;
	for (const logger of loggers.values()) apply(logger);
}

export function getLogThreshold(): LogThreshold {
	return threshold;
}

/** Parse an environment value. Unknown values return `undefined`, never throw. */
export function parseLogThreshold(
	value: string | undefined,
): LogThreshold | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized !== undefined && normalized in RANK
		? (normalized as LogThreshold)
		: undefined;
}

export function createScopedLogger(scope: LogScope): ScopedLogger {
	let base = loggers.get(scope);
	if (base === undefined) {
		base = createLogger(scope);
		apply(base);
		loggers.set(scope, base);
	}
	const palette = base;
	const emit =
		(level: LogLevel) =>
		(message: string, fields?: LogFields, error?: unknown): void => {
			const args: unknown[] = [message];
			if (fields !== undefined) args.push(fields);
			// The error goes last and raw, so the stack survives.
			if (error !== undefined) args.push(error);
			palette[level](...args);
		};
	return {
		debug: emit("debug"),
		info: emit("info"),
		warn: emit("warn"),
		error: emit("error"),
		lazy(level, message, build) {
			if (RANK[level] < RANK[threshold]) return;
			palette[level](message, build());
		},
	};
}
