import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFakeContext,
	type FakeContext,
	type FakeFrame,
} from "../../../__fixtures__/fake-playwright.js";
import type {
	PageEntry,
	PageModule,
	PageModuleEnv,
} from "../../../entities/plugin/index.js";
import {
	createManualClock,
	createSystemClock,
} from "../../../shared/lib/clock/index.js";
import { createObjectIds } from "../../../shared/lib/id/index.js";
import { createScopedLogger } from "../../../shared/lib/logger/index.js";
import type { AttachedContext } from "./attached-context.js";
import { createPageHost } from "./page-host.js";

afterEach(() => vi.restoreAllMocks());

/**
 * Emits one entry at install, echoes commands and state back, and says so
 * when it is undone.
 */
function echoInstaller(
	env: PageModuleEnv<{ mode: string }, { tag: string }>,
): void {
	env.emit({ type: "installed", at: env.now(), text: env.config.tag });
	env.onCommand("echo", (args: unknown) => args);
	env.onCommand("fail", () => {
		throw new Error("bug in the page module");
	});
	env.onState((state) =>
		env.emit({ type: "state", at: env.now(), text: state.mode }),
	);
	env.onDetach(() => env.emit({ type: "undone", at: env.now() }));
}

const attachmentOf = (id: string, context: FakeContext): AttachedContext => ({
	id,
	context,
	cookies: context,
	baseURL: undefined,
});

function setup(
	options: {
		disposables?: boolean;
		clock?: ReturnType<typeof createManualClock>;
	} = {},
) {
	const log = createScopedLogger("Page");
	const host = createPageHost({
		stage: "s1",
		log,
		clock: options.clock ?? createSystemClock(),
		pageId: createObjectIds("p"),
		// Long enough that nothing leaves on a timer: the tests flush.
		flushMs: 10_000,
		timeoutMs: 500,
	});
	const received: {
		entries: readonly PageEntry[];
		page: string;
		context: string;
	}[] = [];
	let mode = "boot";
	const module: PageModule<{ mode: string }, { tag: string }> = {
		id: "echo",
		install: echoInstaller,
		config: { tag: "configured" },
		state: () => ({ mode }),
		receive(entries, source) {
			received.push({ entries, ...source });
		},
	};
	const context = createFakeContext({
		disposables: options.disposables ?? true,
	});
	const attachment = attachmentOf("c1", context);
	return {
		log,
		host,
		module,
		received,
		context,
		attachment,
		/** Every entry received so far, as `page:type`. */
		seen: () =>
			received.flatMap((r) => r.entries.map((e) => `${r.page}:${e.type}`)),
		setMode(next: string) {
			mode = next;
		},
	};
}

async function attached(options?: Parameters<typeof setup>[0]) {
	const harness = setup(options);
	harness.host.register(harness.module);
	await harness.host.attach(harness.attachment);
	return harness;
}

describe("page host", () => {
	it("injects one binding and one script carrying every module", async () => {
		const harness = await attached();
		expect([...harness.context.bindings.keys()]).toEqual(["__wirestage_s1"]);
		expect(harness.context.scripts).toHaveLength(1);
		const page = harness.context.newPage();
		page.load();
		// The hello that carries the state answers asynchronously, so its entry
		// lands in a later flush.
		await vi.waitFor(async () => {
			await harness.host.sync();
			const texts = harness.received.flatMap((r) =>
				r.entries.map((e) => e.text),
			);
			// The installer ran with its config, and the hello delivered the state.
			expect(texts).toEqual(["configured", "boot"]);
		});
		expect(harness.received[0]).toMatchObject({ page: "p1", context: "c1" });
		expect(harness.host.pageId(page)).toBe("p1");
	});

	it("refreshes state and runs commands in every open page, or one", async () => {
		const harness = await attached();
		const first = harness.context.newPage();
		const second = harness.context.newPage();
		first.load();
		second.load();
		harness.setMode("live");
		await harness.host.refresh("echo");
		await harness.host.sync();
		expect(
			harness.received.flatMap((r) =>
				r.entries.filter((e) => e.text === "live").map(() => r.page),
			),
		).toEqual(["p1", "p2"]);
		expect(await harness.host.command("echo", "echo", 7)).toEqual([7, 7]);
		expect(
			await harness.host.command("echo", "echo", 8, { page: "p2" }),
		).toEqual([8]);
		second.close();
		expect(await harness.host.command("echo", "echo", 9)).toEqual([9]);
	});

	it("reaches iframes: a flush, a command and a state change go to every frame", async () => {
		const harness = await attached();
		const page = harness.context.newPage();
		page.load();
		const iframe = page.addFrame();
		iframe.load();
		// A frame the init script never ran in has nothing to say.
		page.addFrame();
		harness.setMode("live");
		await harness.host.refresh("echo");
		// Both frames hold the new state's entry behind their flush window.
		await harness.host.sync();
		expect(
			harness.received.flatMap((r) =>
				r.entries.filter((e) => e.text === "live").map(() => r.page),
			),
		).toEqual(["p1", "p1"]);
		expect(await harness.host.command("echo", "echo", 5)).toEqual([5, 5]);
	});

	it("passes over a frame that is going away", async () => {
		const harness = await attached();
		const page = harness.context.newPage();
		page.load();
		const iframe = page.addFrame();
		iframe.load();
		iframe.detach();
		const debug = vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		expect(await harness.host.command("echo", "echo", 1)).toEqual([1]);
		await harness.host.sync();
		expect(debug).toHaveBeenCalledWith(
			"command skipped",
			{},
			expect.any(Error),
		);
		expect(debug).toHaveBeenCalledWith("flush skipped", {}, expect.any(Error));
	});

	it("goes on without a frame that does not answer in time", async () => {
		const clock = createManualClock();
		const harness = await attached({ clock });
		const stuck = harness.context.newPage();
		stuck.load();
		const fine = harness.context.newPage();
		fine.load();
		// A page behind an open dialog evaluates nothing until it is dismissed.
		vi.spyOn(stuck.frames()[0] as FakeFrame, "evaluate").mockReturnValue(
			new Promise(() => {}),
		);
		const warn = vi.spyOn(harness.log, "warn").mockImplementation(() => {});
		const syncing = harness.host.sync();
		await clock.advance(500);
		await expect(syncing).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("did not answer a flush in time"),
			{ timeoutMs: 500 },
		);
		// The page that could answer was flushed all the same.
		expect(harness.seen()).toContain("p2:installed");
		// And a frame that answers leaves no timer behind.
		expect(clock.pending).toBe(0);
	});

	it("rejects a command whose handler failed in the page, saying where", async () => {
		const harness = await attached();
		harness.context.newPage().load();
		await expect(harness.host.command("echo", "fail")).rejects.toMatchObject({
			code: "INVALID_STATE",
			message: expect.stringContaining(
				'page module "echo" failed to run "fail" in 1 frame(s): Error: bug in the page module',
			),
		});
	});

	it("does nothing in pages when no module is registered", async () => {
		const harness = setup();
		await harness.host.attach(harness.attachment);
		expect(harness.context.bindings.size).toBe(0);
		harness.context.newPage();
		await harness.host.sync();
		expect(await harness.host.command("echo", "x")).toEqual([]);
		// Nothing was put into the context, so there is nothing to take out.
		await harness.host.detach(harness.attachment);
	});

	it("seals registration at the first attach and refuses duplicates", async () => {
		const harness = setup();
		harness.host.register(harness.module);
		expect(() => harness.host.register(harness.module)).toThrow(
			/already registered/,
		);
		await harness.host.attach(harness.attachment);
		expect(() =>
			harness.host.register({ ...harness.module, id: "late" }),
		).toThrow(/registered after the stage was attached/);
	});

	it("refuses to refresh a module it does not know", async () => {
		const { host } = setup();
		await expect(host.refresh("nope")).rejects.toMatchObject({
			code: "INVALID_ARGUMENT",
		});
	});

	it("drops entries for unknown modules and survives a throwing receiver", async () => {
		const harness = setup();
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		harness.host.register({
			...harness.module,
			receive() {
				throw new Error("bad receiver");
			},
		});
		await harness.host.attach(harness.attachment);
		const binding = harness.context.bindings.get("__wirestage_s1");
		const page = harness.context.newPage();
		binding?.(
			{ page },
			{
				type: "entries",
				entries: [
					{ module: "ghost", entry: { type: "x", at: 0 } },
					{ module: "echo", entry: { type: "y", at: 0 } },
				],
			},
		);
		expect(error).toHaveBeenCalledWith(
			"page module failed to receive entries",
			{ module: "echo" },
			expect.any(Error),
		);
	});
});

describe("page host: detaching", () => {
	it("undoes the hooks in open pages, takes what they hold, and leaves the context clean", async () => {
		const harness = await attached();
		const page = harness.context.newPage();
		page.load();
		await harness.host.detach(harness.attachment);
		// The module's own undo ran in the page, and its last entry made it out.
		expect(harness.seen()).toEqual(["p1:installed", "p1:undone"]);
		expect(harness.context.bindings.size).toBe(0);
		expect(harness.context.scripts).toEqual([]);
		// A page loaded afterwards is not touched at all.
		const later = harness.context.newPage();
		later.load();
		expect(later.scope["__wirestage"]).toBeUndefined();
		// Detaching twice, or a context never attached, is harmless.
		await harness.host.detach(harness.attachment);
		await harness.host.detach(attachmentOf("c9", createFakeContext()));
	});

	it("tolerates a context that closed before its hooks could be taken out", async () => {
		const harness = await attached();
		const debug = vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		for (const disposable of harness.context.disposables ?? [])
			vi.spyOn(disposable, "dispose").mockRejectedValue(new Error("closed"));
		await harness.host.detach(harness.attachment);
		expect(debug).toHaveBeenCalledWith(
			"page hook already gone",
			{},
			expect.any(Error),
		);
	});

	it("switches off what an older Playwright cannot take out, and reuses it on re-attach", async () => {
		const harness = await attached({ disposables: false });
		const page = harness.context.newPage();
		page.load();
		await harness.host.detach(harness.attachment);
		expect(harness.seen()).toEqual(["p1:installed", "p1:undone"]);
		// The binding and the script are still in the context...
		expect(harness.context.bindings.size).toBe(1);
		const stray = harness.context.newPage();
		stray.load();
		// ...but what a page says through them now goes nowhere.
		expect(harness.seen()).toHaveLength(2);

		// Attached again, the same binding serves the new attachment: exposing
		// it a second time is what Playwright would refuse.
		await harness.host.attach(attachmentOf("c2", harness.context));
		expect(harness.context.scripts).toHaveLength(1);
		const again = harness.context.newPage();
		again.load();
		expect(harness.received.at(-1)).toMatchObject({ context: "c2" });
		expect(harness.host.pageId(again)).toBe(harness.received.at(-1)?.page);
	});

	it("forgets a context it could not install into, so it can be attached again", async () => {
		const harness = setup();
		harness.host.register(harness.module);
		vi.spyOn(harness.context, "exposeBinding").mockRejectedValueOnce(
			new Error("context closed"),
		);
		await expect(harness.host.attach(harness.attachment)).rejects.toThrow(
			"context closed",
		);
		await harness.host.detach(harness.attachment);
		await harness.host.attach(harness.attachment);
		expect(harness.context.bindings.size).toBe(1);
	});
});
