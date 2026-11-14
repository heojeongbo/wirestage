import type {
	PageEntry,
	PageHost,
	PageModule,
} from "../../../entities/plugin/index.js";
import type {
	BindingSourcePort,
	ContextPort,
	FramePort,
	PagePort,
} from "../../../shared/api/playwright/index.js";
import type { Clock } from "../../../shared/lib/clock/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type { ScopedLogger } from "../../../shared/lib/logger/index.js";
import type { AttachedContext } from "./attached-context.js";
import {
	buildPageScript,
	type CommandResult,
	commandRuntime,
	detachRuntime,
	flushRuntime,
	type RuntimeMessage,
} from "./page-runtime.js";

export interface PageHostDeps {
	readonly stage: string;
	readonly log: ScopedLogger;
	readonly clock: Clock;
	readonly pageId: (page: PagePort) => string;
	/** How long entries may wait for company before a batch leaves. */
	readonly flushMs: number;
	/**
	 * How long a frame may take to answer a flush or a command. A frame that
	 * takes longer is passed over, not waited for: a page stuck behind an
	 * open dialog must not stall every read of the timeline.
	 */
	readonly timeoutMs: number;
}

export interface PageHostEngine extends PageHost {
	attach(attachment: AttachedContext): Promise<void>;
	detach(attachment: AttachedContext): Promise<void>;
	/** Flush every open frame's buffer into the modules, then return. */
	sync(): Promise<void>;
}

/** What recent Playwright returns from `exposeBinding` / `addInitScript`. */
type MaybeDisposable = { dispose?: () => Promise<void> } | undefined;

/** What the host put into one browser context. */
interface Installed {
	/** The attachment its entries belong to; none while detached. */
	current: AttachedContext | undefined;
	/** Takes the binding and the init script back out, where Playwright can. */
	readonly undo: (() => Promise<void>)[];
	/** False when this Playwright returned nothing to take them out with. */
	removable: boolean;
}

/**
 * Node half of the page host: one binding and one init script per context,
 * carrying every registered module.
 *
 * Modules are sealed at the first attach. An init script cannot be amended
 * after the fact, so a module registered later would silently be missing from
 * pages of the contexts already attached; failing loudly is the better DX.
 */
export function createPageHost(deps: PageHostDeps): PageHostEngine {
	const modules = new Map<string, PageModule<unknown, unknown>>();
	const attachments = new Set<AttachedContext>();
	const installed = new WeakMap<ContextPort, Installed>();
	const binding = `__wirestage_${deps.stage}`;
	const { flushMs, timeoutMs } = deps;
	let sealed = false;

	/** Every frame of every open page: page hooks run in iframes too. */
	const openFrames = (
		among: Iterable<AttachedContext>,
		pageFilter?: string,
	): FramePort[] => {
		const frames: FramePort[] = [];
		for (const attachment of among)
			for (const page of attachment.context.pages())
				if (
					!page.isClosed() &&
					(pageFilter === undefined || deps.pageId(page) === pageFilter)
				)
					frames.push(...page.frames());
		return frames;
	};

	/**
	 * Evaluate in one frame, within the time a frame is given. A frame that
	 * is navigating or gone has nothing to say, which is not a failure.
	 */
	const ask = async <Arg, Result>(
		frame: FramePort,
		pageFunction: (arg: Arg) => Result | Promise<Result>,
		arg: Arg,
		what: string,
	): Promise<{ readonly answer: Awaited<Result> } | undefined> => {
		const waiting = new AbortController();
		try {
			return await Promise.race([
				frame
					.evaluate(pageFunction, arg)
					.then((answer) => ({ answer: answer as Awaited<Result> })),
				deps.clock.sleep(timeoutMs, waiting.signal).then(
					() => {
						deps.log.warn(
							`a frame did not answer a ${what} in time and was passed over; what it recorded may be missing (is a dialog open?)`,
							{ timeoutMs },
						);
						return undefined;
					},
					// The frame answered first.
					() => undefined,
				),
			]);
		} catch (error) {
			deps.log.debug(`${what} skipped`, {}, error);
			return undefined;
		} finally {
			waiting.abort();
		}
	};

	const receive = (
		source: BindingSourcePort,
		message: RuntimeMessage,
		attachment: AttachedContext,
	): unknown => {
		if (message.type === "hello") {
			const states: Record<string, unknown> = {};
			for (const [id, module] of modules) states[id] = module.state();
			return states;
		}
		const page = deps.pageId(source.page);
		const byModule = new Map<string, PageEntry[]>();
		for (const { module, entry } of message.entries) {
			const list = byModule.get(module) ?? [];
			list.push(entry as PageEntry);
			byModule.set(module, list);
		}
		for (const [id, entries] of byModule) {
			const module = modules.get(id);
			if (module === undefined) continue;
			try {
				module.receive(entries, { page, context: attachment.id });
			} catch (error) {
				deps.log.error(
					"page module failed to receive entries",
					{ module: id },
					error,
				);
			}
		}
		return undefined;
	};

	const command = async (
		module: string,
		op: string,
		args?: unknown,
		options: { readonly page?: string } = {},
	): Promise<unknown[]> => {
		// No module, no runtime handler: a frame would have nothing to answer.
		if (!modules.has(module)) return [];
		const results = await Promise.all(
			openFrames(attachments, options.page).map((frame) =>
				ask(frame, commandRuntime, { binding, module, op, args }, "command"),
			),
		);
		const answers: unknown[] = [];
		const failures: string[] = [];
		for (const result of results) {
			// No answer, or a frame the init script never ran in.
			const outcome: CommandResult | undefined = result?.answer;
			if (outcome === undefined) continue;
			if ("error" in outcome) failures.push(outcome.error);
			else answers.push(outcome.value);
		}
		if (failures.length > 0)
			// Not "no frame answered": the module's own code failed in the page.
			throw new WirestageError(
				"INVALID_STATE",
				`page module "${module}" failed to run "${op}" in ${failures.length} frame(s): ${failures[0]}`,
				{ details: { module, op, failures } },
			);
		return answers;
	};

	return {
		register(module) {
			if (sealed)
				throw new WirestageError(
					"INVALID_STATE",
					`page module "${module.id}" registered after the stage was attached; register every plugin before calling attach()`,
				);
			if (modules.has(module.id))
				throw new WirestageError(
					"INVALID_ARGUMENT",
					`page module "${module.id}" is already registered`,
				);
			modules.set(module.id, module as PageModule<unknown, unknown>);
		},
		async attach(attachment) {
			sealed = true;
			attachments.add(attachment);
			if (modules.size === 0) return;
			const before = installed.get(attachment.context);
			if (before !== undefined) {
				// Still in the context from an earlier attach this Playwright
				// could not take back: point it at the new attachment.
				before.current = attachment;
				return;
			}
			const slot: Installed = {
				current: attachment,
				undo: [],
				removable: true,
			};
			installed.set(attachment.context, slot);
			const keep = (handle: MaybeDisposable) => {
				if (handle?.dispose === undefined) slot.removable = false;
				else slot.undo.push(() => (handle.dispose as () => Promise<void>)());
			};
			const installers: Record<string, (env: unknown) => void> = {};
			for (const [id, module] of modules)
				installers[id] = module.install as (env: unknown) => void;
			try {
				keep(
					(await attachment.context.exposeBinding(binding, (source, message) =>
						slot.current === undefined
							? undefined
							: receive(source, message as RuntimeMessage, slot.current),
					)) as MaybeDisposable,
				);
				keep(
					(await attachment.context.addInitScript({
						content: buildPageScript(
							{
								binding,
								flushMs,
								modules: [...modules].map(([id, m]) => ({
									id,
									config: m.config,
								})),
							},
							installers,
						),
					})) as MaybeDisposable,
				);
			} catch (error) {
				installed.delete(attachment.context);
				throw error;
			}
		},
		async detach(attachment) {
			if (!attachments.delete(attachment)) return;
			const slot = installed.get(attachment.context);
			if (slot === undefined) return;
			// Undo the hooks in the documents that are open, and take what they
			// still hold, while the binding is there to carry it.
			await Promise.all(
				openFrames([attachment]).map((frame) =>
					ask(frame, detachRuntime, binding, "detach"),
				),
			);
			slot.current = undefined;
			// A Playwright that cannot take a binding or an init script back
			// leaves them in the context, switched off; they serve it again if
			// it is attached again.
			if (!slot.removable) return;
			installed.delete(attachment.context);
			for (const undo of slot.undo)
				await undo().catch((error: unknown) => {
					// A context that closed first took them with it.
					deps.log.debug("page hook already gone", {}, error);
				});
		},
		async sync() {
			if (modules.size === 0) return;
			await Promise.all(
				openFrames(attachments).map((frame) =>
					ask(frame, flushRuntime, binding, "flush"),
				),
			);
		},
		command,
		async refresh(module) {
			const target = modules.get(module);
			if (target === undefined)
				throw new WirestageError(
					"INVALID_ARGUMENT",
					`no page module "${module}" is registered`,
				);
			await command(module, "__state", target.state());
		},
		pageId: deps.pageId,
	};
}
