import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildPageScript,
	commandRuntime,
	detachRuntime,
	flushRuntime,
	type PageRuntimeInit,
	pageRuntime,
	type RuntimeHandle,
} from "./page-runtime.js";

type Scope = Record<string, unknown> & EventTarget;

const BINDING = "__wirestage_test";

function scopeWith(
	reply: (message: unknown) => Promise<unknown> = async () => undefined,
) {
	const scope = new EventTarget() as Scope;
	const sent: unknown[] = [];
	scope[BINDING] = (message: unknown) => {
		sent.push(message);
		return reply(message);
	};
	/** The entry types of each batch sent so far. */
	const batches = () =>
		sent
			.filter((m) => (m as { type: string }).type === "entries")
			.map((m) =>
				(m as { entries: { entry: { type: string } }[] }).entries.map(
					(e) => e.entry.type,
				),
			);
	return { scope, sent, batches };
}

const init = (
	modules: PageRuntimeInit["modules"],
	flushMs = 10,
): PageRuntimeInit => ({
	binding: BINDING,
	flushMs,
	modules,
});

const handleOf = (scope: Scope) =>
	(scope["__wirestage"] as Record<string, RuntimeHandle | undefined>)[BINDING];

interface TestEnv {
	emit(entry: unknown): void;
	encode(bytes: Uint8Array): string;
	decode(text: string): Uint8Array;
	now(): number;
	onCommand(op: string, handler: (args: unknown) => unknown): void;
	onState(handler: (state: unknown) => void): void;
	onDetach(handler: () => void): void;
	config: unknown;
	window: unknown;
}

/** Start a runtime with one module, and hand back that module's env. */
function start(
	harness: ReturnType<typeof scopeWith>,
	flushMs?: number,
): TestEnv {
	let env: TestEnv | undefined;
	pageRuntime(harness.scope, init([{ id: "m", config: { a: 1 } }], flushMs), {
		m: (e) => {
			env = e as TestEnv;
		},
	});
	return env as TestEnv;
}

afterEach(() => {
	vi.useRealTimers();
	delete (globalThis as Record<string, unknown>)["__wirestage"];
});

describe("page runtime", () => {
	it("hands each module its config and the page's window", () => {
		const harness = scopeWith();
		const env = start(harness);
		expect(env.config).toEqual({ a: 1 });
		expect(env.window).toBe(harness.scope);
	});

	it("sends the first entry after a quiet spell at once, and batches a burst", async () => {
		vi.useFakeTimers();
		const harness = scopeWith();
		const env = start(harness, 25);
		// Nothing was sent lately: this one must not wait for company, or a
		// request the page makes right after it would reach Node first.
		env.emit({ type: "first" });
		expect(harness.batches()).toEqual([["first"]]);
		// What follows within the window rides together.
		env.emit({ type: "second" });
		env.emit({ type: "third" });
		expect(harness.batches()).toEqual([["first"]]);
		await vi.advanceTimersByTimeAsync(25);
		expect(harness.batches()).toEqual([["first"], ["second", "third"]]);
		// And after another quiet spell, the next one leaves at once again.
		await vi.advanceTimersByTimeAsync(100);
		env.emit({ type: "fourth" });
		expect(harness.batches()).toEqual([
			["first"],
			["second", "third"],
			["fourth"],
		]);
	});

	it("flushes on demand, cancelling the pending timer", async () => {
		vi.useFakeTimers();
		const harness = scopeWith();
		const env = start(harness, 25);
		env.emit({ type: "one" });
		env.emit({ type: "two" });
		await handleOf(harness.scope)?.flush();
		expect(harness.batches()).toEqual([["one"], ["two"]]);
		// The timer is gone with what it was for: nothing is sent twice.
		await vi.advanceTimersByTimeAsync(50);
		expect(harness.batches()).toHaveLength(2);
		// Nothing queued: no binding call at all.
		await handleOf(harness.scope)?.flush();
		expect(harness.batches()).toHaveLength(2);
	});

	it("swallows a send that fails, at once or from the timer", async () => {
		vi.useFakeTimers();
		const harness = scopeWith(async (message) => {
			if ((message as { type: string }).type === "entries")
				throw new Error("page gone");
		});
		const env = start(harness, 25);
		env.emit({ type: "now" });
		env.emit({ type: "later" });
		await vi.advanceTimersByTimeAsync(30);
		expect(harness.batches()).toEqual([["now"], ["later"]]);
	});

	it("flushes what it holds when the page is hidden", async () => {
		const harness = scopeWith(async (message) => {
			if ((message as { type: string }).type === "entries")
				throw new Error("unloading");
		});
		const env = start(harness, 10_000);
		env.emit({ type: "sent at once" });
		env.emit({ type: "held" });
		harness.scope.dispatchEvent(new Event("pagehide"));
		expect(harness.batches()).toEqual([["sent at once"], ["held"]]);
	});

	it("installs once per realm and needs the binding", () => {
		const { scope, sent } = scopeWith();
		const install = vi.fn();
		pageRuntime(scope, init([{ id: "m", config: null }]), { m: install });
		pageRuntime(scope, init([{ id: "m", config: null }]), { m: install });
		expect(install).toHaveBeenCalledTimes(1);
		expect(sent).toEqual([{ type: "hello" }]);
		const unbound = new EventTarget() as Scope;
		pageRuntime(unbound, init([{ id: "m", config: null }]), { m: install });
		expect(install).toHaveBeenCalledTimes(1);
	});

	it("skips modules without an installer and reports a throwing one", () => {
		const { scope, sent } = scopeWith();
		pageRuntime(
			scope,
			init([
				{ id: "missing", config: null },
				{ id: "broken", config: null },
			]),
			{
				broken: () => {
					throw new Error("no RTCPeerConnection");
				},
			},
		);
		expect(sent).toContainEqual({
			type: "entries",
			entries: [
				{
					module: "broken",
					entry: expect.objectContaining({
						type: "error",
						text: "Error: no RTCPeerConnection",
					}),
				},
			],
		});
	});

	it("encodes and decodes bytes, large ones in chunks", () => {
		const env = start(scopeWith());
		const big = new Uint8Array(0x8000 * 2 + 3).map((_, i) => i % 256);
		const text = env.encode(big);
		expect(Buffer.from(text, "base64")).toEqual(Buffer.from(big));
		expect(env.decode(text)).toEqual(big);
		expect(Math.abs(env.now() - Date.now())).toBeLessThan(1_000);
	});

	it("routes commands and state to the module", async () => {
		const states: unknown[] = [];
		const { scope } = scopeWith(async (message) =>
			(message as { type: string }).type === "hello"
				? { m: { boot: true }, other: undefined }
				: undefined,
		);
		pageRuntime(
			scope,
			init([
				{ id: "m", config: null },
				{ id: "other", config: null },
			]),
			{
				m: (e) => {
					const env = e as TestEnv;
					env.onCommand("ping", (args) => ({ pong: args }));
					env.onState((state) => states.push(state));
					env.onState((state) => states.push(["second", state]));
				},
				other: (e) => {
					(e as TestEnv).onState((state) => states.push(["other", state]));
				},
			},
		);
		await vi.waitFor(() =>
			expect(states).toEqual([{ boot: true }, ["second", { boot: true }]]),
		);
		const handle = handleOf(scope);
		expect(handle?.command("m", "ping", 1)).toEqual({ pong: 1 });
		expect(handle?.command("m", "nope", 1)).toBeUndefined();
		expect(handle?.command("m", "__state", { live: true })).toBe(true);
		expect(handle?.command("unknown", "__state", {})).toBe(true);
		expect(states.at(-1)).toEqual(["second", { live: true }]);
	});

	it("survives a hello with no answer or a rejected one", async () => {
		const quiet = scopeWith(async () => null);
		const onState = vi.fn();
		pageRuntime(quiet.scope, init([{ id: "m", config: null }]), {
			m: (e) => (e as TestEnv).onState(onState),
		});
		const failing = scopeWith(async () => {
			throw new Error("binding gone");
		});
		pageRuntime(failing.scope, init([{ id: "m", config: null }]), {
			m: (e) => (e as TestEnv).onState(onState),
		});
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(onState).not.toHaveBeenCalled();
	});

	it("detaches: undoes every module newest first, sends what is left, and goes quiet", async () => {
		const harness = scopeWith();
		const undone: string[] = [];
		const envs: TestEnv[] = [];
		pageRuntime(
			harness.scope,
			init(
				[
					{ id: "a", config: null },
					{ id: "b", config: null },
				],
				10_000,
			),
			{
				a: (e) => {
					const env = e as TestEnv;
					envs.push(env);
					env.onDetach(() => undone.push("a"));
				},
				b: (e) => {
					const env = e as TestEnv;
					envs.push(env);
					env.onDetach(() => {
						undone.push("b");
						throw new Error("b could not undo");
					});
					env.onDetach(() => undone.push("b again"));
				},
			},
		);
		envs[0]?.emit({ type: "sent at once" });
		envs[0]?.emit({ type: "held" });
		await handleOf(harness.scope)?.detach();
		// One module failing to undo does not keep the others hooked.
		expect(undone).toEqual(["b again", "b", "a"]);
		expect(harness.batches()).toEqual([["sent at once"], ["held"]]);
		// The runtime has stepped aside: no handle, and a module that keeps
		// emitting is talking to nobody.
		expect(handleOf(harness.scope)).toBeUndefined();
		envs[0]?.emit({ type: "after detach" });
		expect(harness.batches()).toHaveLength(2);
	});
});

describe("runtime helpers", () => {
	const install = (handle: RuntimeHandle) => {
		(globalThis as Record<string, unknown>)["__wirestage"] = {
			[BINDING]: handle,
		};
	};
	const ask = (op: string) =>
		commandRuntime({ binding: BINDING, module: "m", op, args: 1 });

	it("do nothing in a frame the runtime never ran in", () => {
		expect(flushRuntime(BINDING)).toBeUndefined();
		expect(detachRuntime(BINDING)).toBeUndefined();
		expect(ask("x")).toBeUndefined();
		install({
			flush: async () => undefined,
			command: () => undefined,
			detach: async () => undefined,
		});
		// Another stage's runtime is not this one's.
		expect(flushRuntime("other")).toBeUndefined();
	});

	it("flush and detach through globalThis", async () => {
		install({
			flush: async () => "flushed",
			command: () => undefined,
			detach: async () => "detached",
		});
		await expect(flushRuntime(BINDING)).resolves.toBe("flushed");
		await expect(detachRuntime(BINDING)).resolves.toBe("detached");
	});

	it("answer a command with its value, or with why its handler failed", async () => {
		install({
			flush: async () => undefined,
			detach: async () => undefined,
			command: (_module, op) => {
				if (op === "throws") throw new Error("handler bug");
				if (op === "rejects") return Promise.reject(new Error("async bug"));
				if (op === "async") return Promise.resolve("later");
				return "answered";
			},
		});
		await expect(ask("x")).resolves.toEqual({ value: "answered" });
		await expect(ask("async")).resolves.toEqual({ value: "later" });
		// A failure crosses as data: a rejected evaluate would read as a frame
		// that went away.
		await expect(ask("throws")).resolves.toEqual({
			error: "Error: handler bug",
		});
		await expect(ask("rejects")).resolves.toEqual({
			error: "Error: async bug",
		});
	});

	it("are self-contained: each runs rebuilt from its source, as in a page", async () => {
		// A new Function has no access to this module's scope, exactly like the
		// page: any reference to an import or a module-level name would throw.
		const scope: Record<string, unknown> = {
			__wirestage: {
				[BINDING]: {
					flush: async () => "flushed",
					command: () => "answered",
					detach: async () => "detached",
				} satisfies RuntimeHandle,
			},
		};
		const rebuilt = <Arg, Result>(fn: (arg: Arg) => Result) =>
			new Function("globalThis", `return (${fn.toString()});`)(scope) as (
				arg: Arg,
			) => Result;
		await expect(rebuilt(flushRuntime)(BINDING)).resolves.toBe("flushed");
		await expect(rebuilt(detachRuntime)(BINDING)).resolves.toBe("detached");
		await expect(
			rebuilt(commandRuntime)({
				binding: BINDING,
				module: "m",
				op: "x",
				args: 1,
			}),
		).resolves.toEqual({ value: "answered" });
	});
});

function recordingInstaller(env: {
	emit(entry: unknown): void;
	config: unknown;
}): void {
	env.emit({ type: "installed", config: env.config });
}

describe("page script", () => {
	it("survives code compiled with esbuild's keepNames", () => {
		// What tsx emits for `const emitNow = () => ...` inside an installer.
		const keptNames = new Function(
			"env",
			'const emitNow = __name(() => env.emit({ type: "named", at: 0 }), "emitNow"); emitNow();',
		) as (env: unknown) => void;
		const { scope, sent } = scopeWith();
		new Function(
			"globalThis",
			buildPageScript(init([{ id: "kept", config: null }]), {
				kept: keptNames,
			}),
		)(scope);
		expect(sent).toContainEqual({
			type: "entries",
			entries: [{ module: "kept", entry: { type: "named", at: 0 } }],
		});
	});

	it("is self-contained: the serialized runtime and installers run on their own", () => {
		const { scope, sent } = scopeWith();
		const script = buildPageScript(init([{ id: "rec", config: { n: 2 } }]), {
			rec: recordingInstaller as (env: unknown) => void,
		});
		new Function("globalThis", script)(scope);
		expect(sent).toContainEqual({
			type: "entries",
			entries: [
				{ module: "rec", entry: { type: "installed", config: { n: 2 } } },
			],
		});
	});
});
