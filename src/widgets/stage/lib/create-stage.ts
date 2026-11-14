import { createTimeline } from "../../../entities/frame/index.js";
import type {
	AnyWirePlugin,
	PluginContext,
	PluginRuntime,
} from "../../../entities/plugin/index.js";
import type {
	ContextPort,
	PagePort,
} from "../../../shared/api/playwright/index.js";
import { createStreamServer } from "../../../shared/api/stream-server/index.js";
import { runAll } from "../../../shared/lib/async/index.js";
import { createSystemClock } from "../../../shared/lib/clock/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import {
	createObjectIds,
	createSequence,
	randomToken,
} from "../../../shared/lib/id/index.js";
import { createScopedLogger } from "../../../shared/lib/logger/index.js";
import type { Stage, StageCore, StageOptions } from "../model/stage.js";
import type { AttachedContext } from "./attached-context.js";
import { createHttpRouter } from "./http-router.js";
import { createPageHost } from "./page-host.js";
import { createReads } from "./reads.js";
import { createSocketRouter } from "./socket-router.js";

/** Names a plugin may not take: they would shadow the stage's own API. */
const RESERVED = new Set<string>([
	"id",
	"timeline",
	"attachments",
	"disposed",
	"attach",
	"detach",
	"pageId",
	"sync",
	"frames",
	"drain",
	"mark",
	"since",
	"between",
	"waitFor",
	"report",
	"dispose",
]);

interface Attached {
	readonly attachment: AttachedContext;
	readonly onClose: () => void;
	/** Plugins whose `attach` was started for this context, in order. */
	readonly runtimes: PluginRuntime<unknown>[];
}

/**
 * Build a stage: one timeline, the shared services plugins are given, and the
 * plugins themselves, each mounted as `stage.<name>`.
 *
 * The stage is the composition root of everything below it. It is the only
 * place the routers, the page host and the stream server are constructed, so
 * a plugin can only ever reach them through its `PluginContext`.
 */
export function createStage<const Plugins extends readonly AnyWirePlugin[]>(
	options: StageOptions<Plugins>,
): Stage<Plugins> {
	const clock = options.clock ?? createSystemClock();
	const id = randomToken().slice(0, 12);
	const log = createScopedLogger("Stage");
	const timeline = createTimeline({
		clock,
		capacity: options.capacity,
		// A subscriber is the test's own code; its failure is its own, and
		// must not break the route handler or page flush that appended.
		onListenerError: (error) =>
			log.error("a timeline subscriber threw", {}, error),
	});
	const pageId = createObjectIds<PagePort>("p");
	const contextId = createSequence("c");
	const streamServer = createStreamServer({
		...options.streamServer,
		log: createScopedLogger("Stream"),
	});
	const http = createHttpRouter({
		timeline,
		log: createScopedLogger("Http"),
		streams: streamServer,
		pageId,
		correlation: createSequence("x"),
	});
	const sockets = createSocketRouter({
		log: createScopedLogger("Socket"),
		correlation: createSequence("w"),
	});
	const pages = createPageHost({
		stage: id,
		log: createScopedLogger("Page"),
		clock,
		pageId,
		flushMs: options.pageFlushMs ?? 25,
		timeoutMs: options.pageTimeoutMs ?? 2_000,
	});
	const attached = new Map<ContextPort, Attached>();
	/** Every plugin's runtime, a plugin's own dependencies before it. */
	const runtimes: PluginRuntime<unknown>[] = [];
	let disposed = false;
	let built = false;

	const sync = async (): Promise<void> => {
		await pages.sync();
		await http.settle();
	};
	const reads = createReads({
		timeline,
		clock,
		sync,
		wait: {
			timeout: options.wait?.timeout ?? 5_000,
			interval: options.wait?.interval ?? 25,
		},
	});

	/** Every step runs even when one fails: a plugin's bug must not leak a route. */
	const detachOne = async (context: ContextPort): Promise<void> => {
		const entry = attached.get(context);
		if (entry === undefined) return;
		attached.delete(context);
		context.off("close", entry.onClose);
		const { attachment } = entry;
		await runAll([
			...[...entry.runtimes]
				.reverse()
				.map((runtime) => () => runtime.detach?.(attachment)),
			() => sockets.detach(attachment),
			() => http.detach(attachment),
			() => pages.detach(attachment),
		]);
		log.debug("detached", { context: attachment.id });
	};

	const core: StageCore = {
		id,
		timeline,
		get attachments() {
			return [...attached.values()].map((entry) => entry.attachment);
		},
		get disposed() {
			return disposed;
		},
		async attach(context, attachOptions = {}) {
			if (disposed)
				throw new WirestageError(
					"INVALID_STATE",
					"cannot attach: the stage is disposed",
				);
			if (attached.has(context))
				throw new WirestageError(
					"INVALID_STATE",
					"this context is already attached to the stage",
				);
			const attachment: AttachedContext = {
				id: contextId(),
				baseURL: attachOptions.baseURL ?? options.baseURL,
				cookies: context,
				context,
			};
			// A closed context takes its routes with it; forgetting it here keeps
			// the next sync from evaluating in pages that no longer exist.
			const onClose = () => {
				detachOne(context).catch((error: unknown) =>
					log.debug("detaching a closed context failed", {}, error),
				);
			};
			const entry: Attached = { attachment, onClose, runtimes: [] };
			attached.set(context, entry);
			context.on("close", onClose);
			try {
				await pages.attach(attachment);
				await http.attach(attachment);
				await sockets.attach(attachment);
				for (const runtime of runtimes) {
					entry.runtimes.push(runtime);
					await runtime.attach?.(attachment);
				}
			} catch (error) {
				// Half-attached is worse than not attached: undo what took, so the
				// caller can fix the cause and attach this context again.
				await detachOne(context).catch((secondary: unknown) =>
					log.debug("undoing a failed attach failed", {}, secondary),
				);
				throw error;
			}
			log.debug("attached", { context: attachment.id });
			return () => detachOne(context);
		},
		async detach(context) {
			if (context !== undefined) return detachOne(context);
			await runAll([...attached.keys()].map((each) => () => detachOne(each)));
		},
		pageId,
		sync,
		...reads,
		async dispose() {
			if (disposed) return;
			disposed = true;
			await runAll([
				() => core.detach(),
				...[...runtimes].reverse().map((runtime) => () => runtime.dispose?.()),
				() => streamServer.close(),
			]);
		},
	};

	/** Set a plugin up, and whatever it builds on first. */
	const mount = (plugin: AnyWirePlugin): PluginRuntime<unknown> => {
		const context: PluginContext = {
			name: plugin.name,
			timeline,
			clock,
			log: createScopedLogger(plugin.scope ?? "Plugin"),
			http,
			sockets,
			pages,
			baseURL: options.baseURL,
			attachments: () => core.attachments,
			sync,
			waitFor: reads.waitFor,
			use(inner) {
				if (built)
					throw new WirestageError(
						"INVALID_STATE",
						`plugin "${plugin.name}" asked for "${inner.name}" after setup; call use() inside setup(), before any context is attached`,
					);
				return mount(inner).api as never;
			},
		};
		const runtime = plugin.setup(context);
		runtimes.push(runtime);
		return runtime;
	};

	const apis = new Map<string, unknown>();
	for (const plugin of options.plugins) {
		if (RESERVED.has(plugin.name) || apis.has(plugin.name))
			throw new WirestageError(
				"INVALID_ARGUMENT",
				RESERVED.has(plugin.name)
					? `plugin name "${plugin.name}" is reserved by the stage`
					: `two plugins are named "${plugin.name}"`,
			);
		apis.set(plugin.name, mount(plugin).api);
	}
	built = true;
	return Object.assign(core, Object.fromEntries(apis)) as Stage<Plugins>;
}
