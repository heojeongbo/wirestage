/**
 * The page half of the page host. Everything in this file that is exported as
 * a function runs INSIDE the page: it is serialized with `toString()`, so it is
 * self-contained — no imports, no references to module scope.
 */

export interface PageRuntimeInit {
	/** The binding Node exposed; also the runtime's key in `__wirestage`. */
	readonly binding: string;
	/** How long entries may wait for company before the batch is flushed. */
	readonly flushMs: number;
	readonly modules: readonly {
		readonly id: string;
		readonly config: unknown;
	}[];
}

/** Messages the runtime sends through the binding. */
export type RuntimeMessage =
	| { readonly type: "hello" }
	| {
			readonly type: "entries";
			readonly entries: readonly {
				readonly module: string;
				readonly entry: unknown;
			}[];
	  };

/** What the runtime publishes on `globalThis.__wirestage[binding]`. */
export interface RuntimeHandle {
	flush(): Promise<unknown>;
	command(module: string, op: string, args: unknown): unknown;
	/** Undo every module's hooks, send what is still held, and step aside. */
	detach(): Promise<unknown>;
}

/** A command's answer, or why its handler failed. */
export type CommandResult =
	| { readonly value: unknown }
	| { readonly error: string };

type Installer = (env: unknown) => void;

/**
 * Install every module, batch what they emit, and answer Node's flushes and
 * commands.
 *
 * Batching is what keeps a 60 Hz channel cheap: one binding call per flush
 * window instead of one per message. The first entry after a quiet spell is
 * not held back, though — it leaves at once, so it reaches Node ahead of a
 * request the page makes right after it and the two land on the timeline in
 * the order they happened.
 *
 * `flush()` returns the binding's promise, so a Node-side `evaluate(flush)`
 * resolves only after Node has appended the entries: a read that flushes
 * first sees everything the page recorded before it.
 */
export function pageRuntime(
	scope: Record<string, unknown>,
	init: PageRuntimeInit,
	installers: Record<string, Installer>,
): void {
	scope["__wirestage"] ??= {};
	const root = scope["__wirestage"] as Record<string, unknown>;
	const bind = scope[init.binding];
	// Init scripts run again in every frame and on every navigation; a second
	// run in the same realm would double every entry.
	if (root[init.binding] !== undefined || typeof bind !== "function") return;
	const send = bind as (message: unknown) => Promise<unknown>;

	const queue: { module: string; entry: unknown }[] = [];
	/** Set by `detach`: a module that keeps emitting is talking to nobody. */
	let detached = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** When the last batch left; far enough back that the first entry is not held. */
	let sentAt = Number.NEGATIVE_INFINITY;
	const commands = new Map<string, (args: unknown) => unknown>();
	const stateHandlers = new Map<string, ((state: unknown) => void)[]>();
	const detachHandlers: (() => void)[] = [];

	const now = () => performance.timeOrigin + performance.now();
	const flush = (): Promise<unknown> => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (queue.length === 0) return Promise.resolve(undefined);
		sentAt = now();
		return send({ type: "entries", entries: queue.splice(0, queue.length) });
	};
	const schedule = () => {
		const wait = sentAt + init.flushMs - now();
		if (wait <= 0) {
			flush().catch(() => {});
			return;
		}
		timer ??= setTimeout(() => {
			timer = undefined;
			flush().catch(() => {});
		}, wait);
	};
	const encode = (bytes: Uint8Array): string => {
		let binary = "";
		// Chunked: spreading a large array into fromCharCode overflows the stack.
		for (let i = 0; i < bytes.length; i += 0x8000)
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return btoa(binary);
	};
	const decode = (text: string): Uint8Array => {
		const binary = atob(text);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	};
	const applyState = (module: string, state: unknown) => {
		for (const handler of stateHandlers.get(module) ?? []) handler(state);
	};

	for (const module of init.modules) {
		const install = installers[module.id];
		if (install === undefined) continue;
		const emit = (entry: unknown) => {
			if (detached) return;
			queue.push({ module: module.id, entry });
			schedule();
		};
		try {
			install({
				window: scope,
				config: module.config,
				emit,
				now,
				encode,
				decode,
				onCommand: (op: string, handler: (args: unknown) => unknown) => {
					commands.set(`${module.id}\u0000${op}`, handler);
				},
				onState: (handler: (state: unknown) => void) => {
					const list = stateHandlers.get(module.id) ?? [];
					list.push(handler);
					stateHandlers.set(module.id, list);
				},
				onDetach: (handler: () => void) => {
					detachHandlers.push(handler);
				},
			});
		} catch (error) {
			// A broken module must not take the page down with it; report it as
			// an entry so the failure shows on the timeline.
			emit({ type: "error", at: now(), text: String(error) });
		}
	}

	const handle: RuntimeHandle = {
		flush,
		command(module, op, args) {
			if (op === "__state") {
				applyState(module, args);
				return true;
			}
			const handler = commands.get(`${module}\u0000${op}`);
			return handler === undefined ? undefined : handler(args);
		},
		detach() {
			// Newest first, so hooks stacked on one another come off in order.
			for (const undo of detachHandlers.splice(0).reverse()) {
				try {
					undo();
				} catch {
					// One module failing to undo must not keep the rest hooked.
				}
			}
			delete root[init.binding];
			detached = true;
			return flush();
		},
	};
	root[init.binding] = handle;
	(scope as unknown as EventTarget).addEventListener("pagehide", () => {
		flush().catch(() => {});
	});
	send({ type: "hello" }).then(
		(states) => {
			const byModule = (states ?? {}) as Record<string, unknown>;
			for (const module of stateHandlers.keys())
				if (byModule[module] !== undefined)
					applyState(module, byModule[module]);
		},
		() => {},
	);
}

/** Flush one frame's runtime. Runs in the page via `frame.evaluate`. */
export function flushRuntime(binding: string): Promise<unknown> | undefined {
	const root = (globalThis as Record<string, unknown>)["__wirestage"] as
		| Record<string, RuntimeHandle | undefined>
		| undefined;
	return root?.[binding]?.flush();
}

/** Detach one frame's runtime. Runs in the page via `frame.evaluate`. */
export function detachRuntime(binding: string): Promise<unknown> | undefined {
	const root = (globalThis as Record<string, unknown>)["__wirestage"] as
		| Record<string, RuntimeHandle | undefined>
		| undefined;
	return root?.[binding]?.detach();
}

/**
 * Run one command in one frame's runtime. Runs in the page via
 * `frame.evaluate`. Undefined when the frame has no runtime (a document the
 * init script never ran in); otherwise the handler's answer, or its failure
 * as text — an exception would cross back to Node as a rejected evaluate,
 * indistinguishable from a frame that went away.
 */
export function commandRuntime(arg: {
	readonly binding: string;
	readonly module: string;
	readonly op: string;
	readonly args: unknown;
}): Promise<CommandResult> | undefined {
	const root = (globalThis as Record<string, unknown>)["__wirestage"] as
		| Record<string, RuntimeHandle | undefined>
		| undefined;
	const handle = root?.[arg.binding];
	if (handle === undefined) return undefined;
	return Promise.resolve()
		.then(() => handle.command(arg.module, arg.op, arg.args))
		.then(
			(value): CommandResult => ({ value }),
			(error: unknown): CommandResult => ({ error: String(error) }),
		);
}

/**
 * The init script: the runtime, then every installer, then the call.
 *
 * Wrapped in a scope that defines `__name`: esbuild's `keepNames` (on by
 * default in tsx) rewrites `const f = () => {}` into `__name(() => {}, "f")`,
 * so code serialized from a tsx-run process calls a helper the page does not
 * have, and the whole runtime dies with "__name is not defined".
 */
export function buildPageScript(
	init: PageRuntimeInit,
	installers: Readonly<Record<string, Installer>>,
): string {
	const list = Object.entries(installers)
		.map(([id, install]) => `${JSON.stringify(id)}: (${install.toString()})`)
		.join(",\n");
	return `(() => {\nconst __name = (target) => target;\n(${pageRuntime.toString()})(globalThis, ${JSON.stringify(init)}, {\n${list}\n});\n})();`;
}
