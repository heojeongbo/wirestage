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
 * when it is undone. The page records a note with `window.note(text)`.
 */
function echoInstaller(
	env: PageModuleEnv<{ mode: string }, { tag: string }>,
): void {
	const win = env.window as unknown as Record<string, unknown>;
	env.emit({ type: "installed", at: env.now(), text: env.config.tag });
	env.onCommand("echo", (args: unknown) => args);
	env.onCommand("fail", () => {
		throw new Error("bug in the page module");
	});
	env.onState((state) =>
		env.emit({ type: "state", at: env.now(), text: state.mode }),
	);
	env.onDetach(() => env.emit({ type: "undone", at: env.now() }));
	win["note"] = (text: string) =>
		env.emit({ type: "note", at: env.now(), text });
	env.onDetach(() => {
		delete win["note"];
	});
}

/** A module whose state handler is broken. */
function brokenStateInstaller(env: PageModuleEnv): void {
	env.onState(() => {
		throw new Error("bug in a state handler");
	});
}

/** What the page does: `window.note(text)`. */
const note = (
	frame: { readonly scope: Record<string, unknown> },
	text: string,
) => (frame.scope["note"] as (text: string) => void)(text);

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
		flushMs?: number;
	} = {},
) {
	const log = createScopedLogger("Page");
	const host = createPageHost({
		stage: "s1",
		log,
		clock: options.clock ?? createSystemClock(),
		pageId: createObjectIds("p"),
		// Long enough that nothing leaves on a timer: the tests flush.
		flushMs: options.flushMs ?? 10_000,
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
		/** The text of every note received so far. */
		notes: () =>
			received.flatMap((r) =>
				r.entries.filter((e) => e.type === "note").map((e) => e.text),
			),
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

	it("keeps what a page held when it navigates, and hooks the next document", async () => {
		const harness = await attached();
		const page = harness.context.newPage();
		page.load();
		// Both wait behind the flush window, which the navigation cuts short.
		note(page, "a");
		note(page, "b");
		page.navigate();
		expect(harness.notes()).toEqual(["a", "b"]);
		note(page, "in the next document");
		await harness.host.sync();
		expect(harness.notes()).toEqual(["a", "b", "in the next document"]);
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

	it("refuses an installer the page could not rebuild, naming the module", () => {
		const { host, module } = setup();
		const refusal = (install: unknown) => {
			try {
				host.register({ ...module, id: "bad", install: install as never });
			} catch (error) {
				return error;
			}
			return undefined;
		};
		// Each serializes to something that is not an expression: in the init
		// script, a SyntaxError that would take every module down with it.
		const shorthand = {
			install(env: PageModuleEnv) {
				env.emit({ type: "x", at: 0 });
			},
		};
		for (const install of [
			shorthand.install,
			echoInstaller.bind(null),
			Math.max,
		])
			expect(refusal(install)).toMatchObject({
				code: "INVALID_ARGUMENT",
				message: expect.stringContaining(
					'page module "bad" cannot run in the page: its install does not serialize to a function expression (SyntaxError',
				),
			});
		// A `function` and an arrow rebuild as they are.
		host.register({ ...module, id: "declared", install: echoInstaller });
		host.register({
			...module,
			id: "arrow",
			install: (env) => env.emit({ type: "x", at: 0 }),
		});
	});

	it("logs a module's handler that threw in the page, naming the module", async () => {
		const harness = setup();
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		harness.host.register({
			...harness.module,
			id: "broken",
			install: brokenStateInstaller as PageModule["install"],
		});
		harness.host.register(harness.module);
		await harness.host.attach(harness.attachment);
		harness.context.newPage().load();
		await vi.waitFor(() =>
			expect(error).toHaveBeenCalledWith(
				"page module failed in its onState handler",
				{ module: "broken", page: "p1" },
				"Error: bug in a state handler",
			),
		);
		// The module after it still got its state.
		await harness.host.sync();
		expect(harness.seen()).toContain("p1:state");
	});

	it("starts every other module when one module's state() throws, and says whose", async () => {
		const harness = setup();
		const error = vi.spyOn(harness.log, "error").mockImplementation(() => {});
		harness.host.register({
			...harness.module,
			id: "broken",
			state: () => {
				throw new Error("bug in state()");
			},
		});
		harness.host.register(harness.module);
		await harness.host.attach(harness.attachment);
		harness.context.newPage().load();
		await vi.waitFor(() =>
			expect(error).toHaveBeenCalledWith(
				"page module failed to give its state",
				{ module: "broken" },
				expect.objectContaining({ message: "bug in state()" }),
			),
		);
		// Before, the throw ended the hello: no module in the page got a state.
		await harness.host.sync();
		expect(harness.seen()).toContain("p1:state");
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
		// The state the page was sent, held behind the flush window, came out
		// with the detach; the module's own undo ran, and its last entry too.
		expect(harness.seen()).toEqual(["p1:installed", "p1:state", "p1:undone"]);
		expect(page.scope["note"]).toBeUndefined();
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

	for (const during of ["init script", "binding"] as const)
		it(`leaves no hooks in a document that loads while the ${during} is taken out`, async () => {
			const harness = await attached();
			const page = harness.context.newPage();
			page.load();
			const [binding, script] = harness.context.disposables ?? [];
			const handle = during === "binding" ? binding : script;
			if (handle === undefined) throw new Error("nothing to take out");
			const dispose = handle.dispose;
			vi.spyOn(handle, "dispose").mockImplementation(async () => {
				page.navigate();
				await dispose();
			});
			await harness.host.detach(harness.attachment);
			// The init script comes out first: a document after it has no
			// runtime, and one before it is detached with the rest. Taken out
			// last, it would hand the reload a runtime whose binding is gone.
			expect(page.scope["note"]).toBeUndefined();
			expect(
				(page.scope["__wirestage"] as Record<string, unknown> | undefined)?.[
					"__wirestage_s1"
				],
			).toBeUndefined();
		});

	it("lets a document the detach did not reach step aside once the binding is gone", async () => {
		// No flush window: the page's call goes straight to the binding.
		const harness = await attached({ flushMs: 0 });
		const page = harness.context.newPage();
		page.load();
		// The detach's evaluate fails there, as in a document being replaced.
		vi.spyOn(page.frames()[0] as FakeFrame, "evaluate").mockRejectedValueOnce(
			new Error("Execution context was destroyed"),
		);
		vi.spyOn(harness.log, "debug").mockImplementation(() => {});
		await harness.host.detach(harness.attachment);
		expect(typeof page.scope["note"]).toBe("function");
		// The binding it holds now throws; the app's call must not.
		expect(() => note(page, "after the stage")).not.toThrow();
		// The runtime undid every module instead, and stepped aside.
		expect(page.scope["note"]).toBeUndefined();
		expect(page.scope["__wirestage"]).toEqual({});
		expect(harness.notes()).toEqual([]);
	});

	it("does not wait for a page behind a dialog to give its hooks back", async () => {
		const clock = createManualClock();
		const harness = await attached({ clock });
		harness.context.newPage().load();
		// Playwright's dispose() returns once every page has done its part; a
		// page behind a dialog does nothing until the dialog is closed.
		for (const disposable of harness.context.disposables ?? [])
			vi.spyOn(disposable, "dispose").mockReturnValue(new Promise(() => {}));
		const warn = vi.spyOn(harness.log, "warn").mockImplementation(() => {});
		let done = false;
		void harness.host.detach(harness.attachment).then(() => {
			done = true;
		});
		await clock.advance(500);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("the page init script was not taken out in time"),
			{ timeoutMs: 500 },
		);
		expect(done).toBe(false);
		await clock.advance(500);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("the page binding was not taken out in time"),
			{ timeoutMs: 500 },
		);
		expect(done).toBe(true);
		// The open page was still detached, and nothing is left waiting.
		expect(harness.seen()).toContain("p1:undone");
		expect(clock.pending).toBe(0);
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

	it("takes the binding back out when the init script cannot go in", async () => {
		const harness = setup();
		harness.host.register(harness.module);
		vi.spyOn(harness.context, "addInitScript").mockRejectedValueOnce(
			new Error("page crashed"),
		);
		await expect(harness.host.attach(harness.attachment)).rejects.toThrow(
			"page crashed",
		);
		expect(harness.context.bindings.size).toBe(0);
		// Left in, the binding would make this attach fail: "already registered".
		await harness.host.detach(harness.attachment);
		await harness.host.attach(harness.attachment);
		expect(harness.context.bindings.size).toBe(1);
		expect(harness.context.scripts).toHaveLength(1);
	});
});
