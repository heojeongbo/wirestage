import { getLogger, setGlobalLevel } from "@heojeongbo/log-palette";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createScopedLogger,
	getLogThreshold,
	parseLogThreshold,
	setLogThreshold,
} from "./index.js";

afterEach(() => {
	setLogThreshold("warn");
	vi.restoreAllMocks();
});

describe("logger", () => {
	it("defaults to warn, so a passing suite prints nothing", () => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(getLogThreshold()).toBe("warn");
		const log = createScopedLogger("Stage");
		log.debug("hidden");
		log.warn("shown", { a: 1 }, new Error("e"));
		expect(debug).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		const args = warn.mock.calls[0] ?? [];
		// Badge, then the message, the fields and the raw error — in that order,
		// so the stack survives.
		expect(String(args[0])).toContain("Stage");
		expect(args.slice(3)).toEqual(["shown", { a: 1 }, new Error("e")]);
	});

	it("omits fields and errors that were not given", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		setLogThreshold("debug");
		createScopedLogger("Http").info("plain");
		createScopedLogger("Http").error("with error", undefined, "boom");
		expect(info.mock.calls[0]?.slice(3)).toEqual(["plain"]);
		expect(error.mock.calls[0]?.slice(3)).toEqual(["with error", "boom"]);
	});

	it("builds lazy payloads only when they will print", () => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		const build = vi.fn(() => ({ heavy: true }));
		const log = createScopedLogger("Page");
		log.lazy("debug", "skipped", build);
		expect(build).not.toHaveBeenCalled();
		setLogThreshold("debug");
		log.lazy("debug", "built", build);
		expect(build).toHaveBeenCalledTimes(1);
		expect(debug).toHaveBeenCalledTimes(1);
	});

	it("goes fully silent", () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		setLogThreshold("silent");
		createScopedLogger("Rtc").error("nothing");
		expect(errorLog).not.toHaveBeenCalled();
		expect(getLogThreshold()).toBe("silent");
	});

	it("parses environment values without throwing", () => {
		expect(parseLogThreshold(" DEBUG ")).toBe("debug");
		expect(parseLogThreshold("silent")).toBe("silent");
		expect(parseLogThreshold("loud")).toBeUndefined();
		expect(parseLogThreshold(undefined)).toBeUndefined();
	});

	it("gives a plugin's own scope the current threshold, whenever it appears", () => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		setLogThreshold("silent");
		const quiet = createScopedLogger("GraphQL");
		quiet.warn("dropped");
		expect(warn).not.toHaveBeenCalled();
		setLogThreshold("debug");
		quiet.debug("printed");
		createScopedLogger("Mqtt").debug("printed too");
		expect(debug).toHaveBeenCalledTimes(2);
		expect(String(debug.mock.calls[0]?.[0])).toContain("GraphQL");
	});

	it("leaves the loggers of the code under test alone", () => {
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		// A logger of the app's own, in the registry log-palette shares
		// process-wide, under a name the library also uses.
		const theirs = getLogger("Stage", { level: "debug" });
		setLogThreshold("silent");
		theirs.debug("still mine");
		expect(debug).toHaveBeenCalledTimes(1);
		// And the other way round.
		setLogThreshold("warn");
		setGlobalLevel("debug");
		createScopedLogger("Stage").debug("still filtered");
		expect(debug).toHaveBeenCalledTimes(1);
	});
});
