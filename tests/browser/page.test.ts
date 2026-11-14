/**
 * The page host against a real Chromium, through the real Playwright API:
 * what a page holds when it goes away, how detaching treats pages that load,
 * stall or lose the binding meanwhile, and what `src/__fixtures__` claims
 * Playwright does with bindings and navigations.
 */
import type { Dialog, Disposable, Frame, Page } from "@playwright/test";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
	type AnyWirePlugin,
	createStage,
	definePlugin,
	type PageInstaller,
	type PageModuleEnv,
	type StageCore,
} from "../../src/index.js";
import { webrtc } from "../../src/webrtc.js";
import { buildPageScript } from "../../src/widgets/stage/lib/page-runtime.js";
import { close, contextWithPage, ORIGIN } from "./harness.js";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
	vi.restoreAllMocks();
});
afterAll(close);

const later = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs in the page: `window.note(text)` records one entry. */
function installNotes(env: PageModuleEnv): void {
	const win = env.window as unknown as Record<string, unknown>;
	win["note"] = (text: string) =>
		env.emit({ type: "note", at: env.now(), text });
	env.onDetach(() => {
		delete win["note"];
	});
}

const notes = definePlugin({
	name: "notes",
	setup(context) {
		context.pages.register({
			id: context.name,
			install: installNotes,
			config: null,
			state: () => null,
			receive(entries, source) {
				for (const entry of entries)
					context.timeline.append({
						protocol: context.name,
						kind: "message",
						direction: "out",
						endpoint: "note",
						source: "page",
						data: entry.text ?? "",
						page: source.page,
						context: source.context,
					});
			},
		});
		return { api: {} };
	},
});

/** What the page's notes recorded since a marker. */
const notesSince = async (stage: Pick<StageCore, "since">, mark: string) =>
	(await stage.since(mark, { protocol: "notes" })).map((frame) =>
		frame.payload.text(),
	);

/**
 * `window.note(text)` for each text, in a page or a frame — then, with
 * `href`, navigate it in the same turn.
 */
const write = (target: Page | Frame, texts: readonly string[], href?: string) =>
	target.evaluate(
		({ all, next }) => {
			for (const text of all)
				(window as unknown as { note(text: string): void }).note(text);
			if (next !== undefined) location.href = next;
		},
		{ all: texts, next: href },
	);

const FRAME = "<!doctype html><title>frame</title>";

/** A stage on a new context, its page loaded; `/frame` serves an iframe. */
async function stageOn<const Plugins extends readonly AnyWirePlugin[]>(
	plugins: Plugins,
	options: { pageFlushMs?: number } = {},
) {
	const { context, page } = await contextWithPage(
		"<!doctype html><title>t</title>",
	);
	await context.route(
		(url) => url.pathname === "/frame",
		(route) =>
			route.fulfill({ status: 200, contentType: "text/html", body: FRAME }),
	);
	const stage = createStage({
		plugins,
		...(options.pageFlushMs === undefined
			? {}
			: { pageFlushMs: options.pageFlushMs }),
	});
	await stage.attach(context, { baseURL: ORIGIN });
	disposers.push(async () => {
		await stage.dispose();
		await context.close();
	});
	await page.goto(`${ORIGIN}/`);
	return { stage, context, page };
}

/** An iframe at `/frame`, by that name, loaded. */
async function addFrame(page: Page, name: string): Promise<Frame> {
	await page.evaluate(
		(frameName) =>
			new Promise<void>((resolve) => {
				const frame = document.createElement("iframe");
				frame.name = frameName;
				frame.src = "/frame";
				frame.onload = () => resolve();
				document.body.append(frame);
			}),
		name,
	);
	const inner = page.frame({ name });
	if (inner === null) throw new Error(`the iframe "${name}" did not load`);
	return inner;
}

/** Take the iframe of that name out of the page. */
const removeFrame = (page: Page, name: string) =>
	page.evaluate(
		(frameName) =>
			document.querySelector(`iframe[name="${frameName}"]`)?.remove(),
		name,
	);

describe("what a page holds when it goes away", () => {
	// The default window, and one no timer beats: only the unload can deliver.
	for (const pageFlushMs of [undefined, 60_000])
		it(`keeps what a page wrote right before it navigates, every way it can (pageFlushMs ${pageFlushMs ?? "default"})`, async () => {
			const { stage, page } = await stageOn([notes], { pageFlushMs });
			// The first note leaves at once; the others wait for company, and
			// the navigation follows them before any timer can.
			const texts = (how: string) => [`${how} 1`, `${how} 2`, `${how} 3`];
			const navigations: Record<string, () => Promise<unknown>> = {
				"location.href": async () => {
					await write(page, texts("location.href"), "/?href");
					await page.waitForURL("**/?href");
				},
				"page.goto": async () => {
					await write(page, texts("page.goto"));
					await page.goto(`${ORIGIN}/?goto`);
				},
				"page.reload": async () => {
					await write(page, texts("page.reload"));
					await page.reload();
				},
			};
			for (const [how, navigate] of Object.entries(navigations)) {
				await stage.mark(how);
				await navigate();
				await expect.poll(() => notesSince(stage, how)).toEqual(texts(how));
			}
		});

	it("keeps what an iframe held when it navigates, or the page around it does", async () => {
		const { stage, page } = await stageOn([notes], { pageFlushMs: 60_000 });
		const first = await addFrame(page, "first");
		await stage.mark("frame navigates");
		await write(first, ["a", "b"], "/frame?next");
		await first.waitForURL("**/frame?next");
		await expect
			.poll(() => notesSince(stage, "frame navigates"))
			.toEqual(["a", "b"]);

		const second = await addFrame(page, "second");
		await stage.mark("page navigates");
		await write(second, ["c", "d"]);
		await page.goto(`${ORIGIN}/?away`);
		await expect
			.poll(() => notesSince(stage, "page navigates"))
			.toEqual(["c", "d"]);
	});

	it("keeps what a page held when it closes, and an iframe when it is removed", async () => {
		const { stage, context, page } = await stageOn([notes], {
			pageFlushMs: 60_000,
		});
		const inner = await addFrame(page, "removed");
		await stage.mark("removed");
		await write(inner, ["a", "b"]);
		await removeFrame(page, "removed");
		await expect.poll(() => notesSince(stage, "removed")).toEqual(["a", "b"]);

		const second = await context.newPage();
		await second.goto(`${ORIGIN}/`);
		await stage.mark("closed");
		await write(second, ["c", "d"]);
		await second.close();
		await expect.poll(() => notesSince(stage, "closed")).toEqual(["c", "d"]);
	});

	it("loses what a page writes once it is already going away", async () => {
		// The page's own handlers run after the stage's flush, which a batch
		// just left by; what they write waits, and goes with the document.
		const { stage, context } = await stageOn([notes], {
			pageFlushMs: 60_000,
		});
		const own = `<!doctype html><script>
			addEventListener("beforeunload", () => window.note("own beforeunload"));
			addEventListener("pagehide", () => window.note("own pagehide"));
		</script>`;
		await context.route(
			(url) => url.pathname === "/own",
			(route) =>
				route.fulfill({ status: 200, contentType: "text/html", body: own }),
		);
		const page = await context.newPage();
		await page.goto(`${ORIGIN}/own`);
		await stage.mark("navigates");
		await write(page, ["a", "b"]);
		await page.goto(`${ORIGIN}/`);
		await later(300);
		expect(await notesSince(stage, "navigates")).toEqual(["a", "b"]);

		await page.goto(`${ORIGIN}/own`);
		await stage.mark("closes");
		await write(page, ["c", "d"]);
		await page.close();
		await later(300);
		expect(await notesSince(stage, "closes")).toEqual(["c", "d"]);
	});
});

describe("bindings in Chromium, as the fakes have them", () => {
	it("deliver a call from beforeunload, and lose one from pagehide, when the main frame navigates", async () => {
		// Each document reports its unload events, naming itself.
		const html = `<!doctype html><script>
			const name = location.pathname + location.search;
			for (const type of ["beforeunload", "pagehide"])
				addEventListener(type, () => window.__probe(type + " " + name));
		</script>`;
		const { context, page } = await contextWithPage(html);
		disposers.push(() => context.close());
		const calls: string[] = [];
		await context.exposeBinding("__probe", (_source, text: string) => {
			calls.push(text);
		});
		await context.route(
			(url) => url.pathname === "/frame",
			(route) =>
				route.fulfill({ status: 200, contentType: "text/html", body: html }),
		);
		await page.goto(`${ORIGIN}/`);
		await page.goto(`${ORIGIN}/?next`);
		await later(300);
		expect(calls).toEqual(["beforeunload /"]);
		// No `beforeunload` for an iframe removed or a page closed, and the
		// call from `pagehide` arrives.
		await addFrame(page, "probe");
		await removeFrame(page, "probe");
		await expect.poll(() => calls).toContain("pagehide /frame");
		await page.close();
		await expect.poll(() => calls).toContain("pagehide /?next");
		expect(calls).toHaveLength(3);
	});

	it("throw, synchronously, once removed — while one that throws in Node rejects", async () => {
		const { context, page } = await contextWithPage(
			"<!doctype html><title>t</title>",
		);
		disposers.push(() => context.close());
		const removed = await context.exposeBinding("__removed", () => "answered");
		await context.exposeBinding("__failing", () => {
			throw new Error("thrown in Node");
		});
		await page.goto(`${ORIGIN}/`);
		await page.evaluate(() => {
			const win = window as unknown as Record<string, unknown>;
			win["kept"] = win["__removed"];
		});
		await removed.dispose();
		const outcome = await page.evaluate(async () => {
			const win = window as unknown as Record<
				string,
				(text: string) => Promise<unknown>
			>;
			const call = (name: string) => {
				try {
					return { returned: win[name]?.("x") };
				} catch (error) {
					return { threw: String(error) };
				}
			};
			const kept = call("kept");
			const failing = call("__failing");
			return {
				global: typeof win["__removed"],
				kept,
				failing: await failing.returned?.then(
					() => "resolved",
					(error: Error) => `rejected: ${error.message}`,
				),
			};
		});
		expect(outcome).toEqual({
			global: "undefined",
			kept: { threw: 'Error: binding "__removed" has been removed' },
			failing: expect.stringContaining("rejected: thrown in Node"),
		});
	});
});

describe("detaching in Chromium", () => {
	/** Two peers in one page, connected over loopback, with one data channel. */
	const LOOPBACK = `<!doctype html><script>
		window.connect = async () => {
			const a = new RTCPeerConnection();
			const b = new RTCPeerConnection();
			a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
			b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
			b.ondatachannel = (e) => { window.remote = e.channel; };
			const channel = a.createDataChannel("robot/teleop");
			window.local = channel;
			await a.setLocalDescription(await a.createOffer());
			await b.setRemoteDescription(a.localDescription);
			await b.setLocalDescription(await b.createAnswer());
			await a.setRemoteDescription(b.localDescription);
			await new Promise((resolve) => (channel.onopen = resolve));
			await new Promise((resolve) => { const wait = () => (window.remote && window.remote.readyState === "open" ? resolve() : setTimeout(wait, 10)); wait(); });
		};
	</script>`;

	it("does not wait for a page behind a dialog", async () => {
		const { context, page } = await contextWithPage(LOOPBACK);
		disposers.push(() => context.close());
		const stage = createStage({ plugins: [webrtc()], pageTimeoutMs: 500 });
		await stage.attach(context);
		await page.goto(`${ORIGIN}/`);
		const dialog = new Promise<Dialog>((resolve) =>
			page.once("dialog", resolve),
		);
		await page.evaluate(() => {
			setTimeout(() => confirm("leave?"), 0);
		});
		const open = await dialog;
		let disposed = false;
		const disposing = stage.dispose().then(() => {
			disposed = true;
		});
		// The init script, the page, the binding: 500 ms each at most. Before,
		// Playwright's dispose() held the teardown until the dialog closed.
		await expect.poll(() => disposed, { timeout: 5_000 }).toBe(true);
		await open.accept();
		await disposing;
		// Playwright finishes once the page answers: the next document is clean.
		await page.reload();
		expect(
			await page.evaluate(
				() => (window as unknown as Record<string, unknown>)["__wirestage"],
			),
		).toBeUndefined();
	});

	it("leaves no hooks in a document that loads while the stage detaches", async () => {
		const install: PageInstaller = function install(env) {
			const scope = env.window as unknown as Record<string, unknown>;
			scope["__emit"] = (type: string) => env.emit({ type, at: env.now() });
			env.onDetach(() => {
				delete scope["__emit"];
			});
		};
		const racing = definePlugin({
			name: "racing",
			setup(context) {
				context.pages.register({
					id: "racing",
					install,
					config: null,
					state: () => null,
					receive: () => {},
				});
				return { api: {} };
			},
		});
		const { context, page } = await contextWithPage(
			"<!doctype html><title>t</title>",
		);
		disposers.push(() => context.close());
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		const outcomes: string[] = [];
		for (let round = 0; round < 20; round++) {
			const stage = createStage({ plugins: [racing], pageFlushMs: 5 });
			await stage.attach(context);
			await page.goto(`${ORIGIN}/`);
			// The reload commits somewhere inside the detach.
			const reloading = page.reload();
			await later(round % 5);
			await stage.dispose();
			await reloading;
			outcomes.push(
				await page.evaluate(() => {
					const emit = (
						window as unknown as { __emit?: (type: string) => void }
					).__emit;
					if (emit === undefined) return "clean";
					try {
						emit("x");
						return "hooked";
					} catch (error) {
						return `hooked and throws: ${String(error)}`;
					}
				}),
			);
		}
		// Before, nearly every round left a runtime whose binding was gone.
		expect(new Set(outcomes)).toEqual(new Set(["clean"]));
		expect(errors).toEqual([]);
	});

	it("steps aside when its binding is removed under it: the app's own send never throws", async () => {
		const { context, page } = await contextWithPage(LOOPBACK);
		disposers.push(() => context.close());
		// Catch the stage's binding, to take it away the way a detach that did
		// not reach this document leaves it.
		const exposed: Disposable[] = [];
		const expose = context.exposeBinding.bind(context);
		vi.spyOn(context, "exposeBinding").mockImplementation(
			async (name, binding) => {
				const handle = await expose(name, binding);
				exposed.push(handle);
				return handle;
			},
		);
		const stage = createStage({ plugins: [webrtc()], pageFlushMs: 5 });
		await stage.attach(context);
		disposers.push(() => stage.dispose());
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		await page.goto(`${ORIGIN}/`);
		await page.evaluate(() =>
			(window as unknown as { connect(): Promise<void> }).connect(),
		);
		await stage.sync();
		await exposed[0]?.dispose();
		// Past the flush window, so the send goes straight to the binding.
		await later(50);
		const outcome = await page.evaluate(() => {
			try {
				(window as unknown as { local: RTCDataChannel }).local.send("x");
				return "sent";
			} catch (error) {
				return `threw ${String(error)}`;
			}
		});
		expect(outcome).toBe("sent");
		// The plugin's hooks are off: what the page has is the browser's own.
		expect(
			await page.evaluate(() => ({
				send: String(RTCDataChannel.prototype.send).includes("[native code]"),
				constructor: String(RTCPeerConnection).includes("[native code]"),
			})),
		).toEqual({ send: true, constructor: true });
		expect(errors).toEqual([]);
	});

	it("undoes an attach that failed half-way, so the context can be attached again", async () => {
		const { context, page } = await contextWithPage(
			"<!doctype html><title>t</title>",
		);
		disposers.push(() => context.close());
		const stage = createStage({ plugins: [notes] });
		vi.spyOn(context, "addInitScript").mockRejectedValueOnce(
			new Error("page crashed"),
		);
		await expect(stage.attach(context)).rejects.toThrow("page crashed");
		// With the binding left in, Playwright refuses it: "already registered".
		await stage.attach(context);
		disposers.push(() => stage.dispose());
		await page.goto(`${ORIGIN}/`);
		await stage.mark("attached again");
		await write(page, ["recorded"]);
		expect(await notesSince(stage, "attached again")).toEqual(["recorded"]);
	});
});

describe("page module failures in Chromium", () => {
	it("give the other modules their state when one module's handler throws, and nothing is thrown in the page", async () => {
		const broken: PageInstaller = function broken(env) {
			env.onState(() => {
				throw new Error("bug in a state handler");
			});
		};
		const fine: PageInstaller = function fine(env) {
			env.onState((state) => {
				(env.window as unknown as Record<string, unknown>)["got"] = state;
			});
		};
		const twoModules = definePlugin({
			name: "two",
			setup(context) {
				for (const [id, install] of [
					["broken", broken],
					["fine", fine],
				] as const)
					context.pages.register({
						id,
						install,
						config: null,
						state: () => ({ ready: id }),
						receive: () => {},
					});
				return { api: {} };
			},
		});
		const { context, page } = await contextWithPage(
			"<!doctype html><title>t</title>",
		);
		disposers.push(() => context.close());
		const stage = createStage({ plugins: [twoModules] });
		await stage.attach(context);
		disposers.push(() => stage.dispose());
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(String(error)));
		await page.goto(`${ORIGIN}/`);
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as unknown as Record<string, unknown>)["got"],
				),
			)
			.toEqual({ ready: "fine" });
		await later(100);
		expect(errors).toEqual([]);
	});

	it("are refused at register exactly when Chromium could not run the installer", async () => {
		const { context } = await contextWithPage(
			"<!doctype html><title>t</title>",
		);
		disposers.push(() => context.close());
		const shorthand = {
			install(env: PageModuleEnv) {
				env.emit({ type: "x", at: 0 });
			},
		};
		class Module {
			install(env: PageModuleEnv): void {
				env.emit({ type: "x", at: 0 });
			}
		}
		const shapes: Record<string, unknown> = {
			"a function": installNotes,
			"an arrow": (env: PageModuleEnv) => env.emit({ type: "x", at: 0 }),
			"an async function": async function install() {},
			"an object method": shorthand.install,
			"a class method": new Module().install,
			"a bound function": installNotes.bind(null),
			"a native function": Math.max,
		};
		const verdicts: Record<string, { registered: boolean; ran: boolean }> = {};
		for (const [shape, install] of Object.entries(shapes)) {
			let registered = true;
			try {
				createStage({
					plugins: [
						definePlugin({
							name: "shaped",
							setup(setupContext) {
								setupContext.pages.register({
									id: "shaped",
									install: install as PageInstaller,
									config: null,
									state: () => null,
									receive: () => {},
								});
								return { api: {} };
							},
						}),
					],
				});
			} catch {
				registered = false;
			}
			// The init script the stage would build, run by Chromium as one.
			const page = await context.newPage();
			await page.addInitScript({
				content: buildPageScript(
					{
						binding: "__wirestage_shaped",
						flushMs: 25,
						modules: [{ id: "shaped", config: null }],
					},
					{ shaped: install as (env: unknown) => void },
				),
			});
			await page.goto(`${ORIGIN}/`);
			const ran = await page.evaluate(
				() =>
					typeof (window as unknown as Record<string, unknown>)[
						"__wirestage"
					] === "object",
			);
			await page.close();
			verdicts[shape] = { registered, ran };
		}
		expect(verdicts).toEqual({
			"a function": { registered: true, ran: true },
			"an arrow": { registered: true, ran: true },
			"an async function": { registered: true, ran: true },
			"an object method": { registered: false, ran: false },
			"a class method": { registered: false, ran: false },
			"a bound function": { registered: false, ran: false },
			"a native function": { registered: false, ran: false },
		});
	});
});
