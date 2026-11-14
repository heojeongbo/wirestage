import type { PagePort } from "../../../shared/api/playwright/index.js";

/** One thing an in-page module observed, on its way to the timeline. */
export interface PageEntry {
	/** The module's own discriminator: `out`, `in`, `open`, ... */
	readonly type: string;
	/** Epoch milliseconds, by the page's clock. */
	readonly at: number;
	/** A binary payload, base64. */
	readonly data?: string;
	/** A text payload. */
	readonly text?: string;
	readonly meta?: Readonly<Record<string, unknown>>;
}

/** What the page runtime hands an installer, inside the page. */
export interface PageModuleEnv<State = unknown, Config = unknown> {
	readonly window: Window & typeof globalThis;
	readonly config: Config;
	/** Queue an entry. Entries are batched and flushed to Node. */
	emit(entry: PageEntry): void;
	/** The page's epoch-millisecond clock. */
	now(): number;
	/** Bytes to base64. */
	encode(bytes: Uint8Array): string;
	/** Base64 to bytes, in a fresh ArrayBuffer of exactly that size. */
	decode(text: string): Uint8Array;
	/** Answer a command the test sends with `PageHost.command`. */
	onCommand(op: string, handler: (args: never) => unknown): void;
	/**
	 * Receive the module's state: shortly after load (it comes from Node, so
	 * the document's first script may run before it), and on every change.
	 */
	onState(handler: (state: State) => void): void;
	/**
	 * Undo what `install` did to the page: put back what was wrapped. Runs
	 * when the stage detaches, so a document that outlives the stage is left
	 * as the stage found it.
	 */
	onDetach(handler: () => void): void;
}

/**
 * Runs INSIDE the page, so it is serialized with `Function.prototype.toString`.
 * It must be self-contained — no imports, no closure over module scope — and
 * declared with `function`, since an object-method body does not serialize to
 * a valid expression.
 */
export type PageInstaller<State = unknown, Config = unknown> = (
	env: PageModuleEnv<State, Config>,
) => void;

export interface PageSource {
	readonly page: string;
	readonly context: string;
}

export interface PageModule<State = unknown, Config = unknown> {
	/** Unique per stage; the key commands and entries are routed by. */
	readonly id: string;
	readonly install: PageInstaller<State, Config>;
	/** JSON-serializable; fixed for the life of the attachment. */
	readonly config: Config;
	/** The state a freshly loaded page should start with. JSON-serializable. */
	state(): State;
	/** Entries flushed from a page, in emission order. */
	receive(entries: readonly PageEntry[], source: PageSource): void;
}

/**
 * Where plugins put code that runs in every page. Modules register at setup;
 * the host injects them all as one init script per attached context, with one
 * binding back to Node.
 */
export interface PageHost {
	register<State, Config>(module: PageModule<State, Config>): void;
	/**
	 * Run a module's command handler in every frame of every open page (or of
	 * one page, by id) and return each frame's answer. Frames that are going
	 * away are skipped; a handler that throws rejects the call.
	 */
	command(
		module: string,
		op: string,
		args?: unknown,
		options?: { readonly page?: string },
	): Promise<unknown[]>;
	/**
	 * Send the module's current `state()` to every frame of every open page.
	 * Documents loaded later ask for it when their runtime starts.
	 */
	refresh(module: string): Promise<void>;
	/** The id frames use for `page`. */
	pageId(page: PagePort): string;
}
