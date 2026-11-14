import { createTimeline } from "../../../entities/frame/index.js";
import type {
	AnyWirePlugin,
	Attachment,
	PluginContext,
	PluginRuntime,
} from "../../../entities/plugin/index.js";
import type {
	ContextPort,
	CookieJarPort,
	PagePort,
} from "../../../shared/api/playwright/index.js";
import { createStreamServer } from "../../../shared/api/stream-server/index.js";
import { runAll } from "../../../shared/lib/async/index.js";
import { createSystemClock } from "../../../shared/lib/clock/index.js";
import type { CookieInit } from "../../../shared/lib/cookies/index.js";
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
	"cursor",
	"since",
	"between",
	"waitFor",
	"report",
	"dispose",
]);

interface Attached {
	readonly attachment: AttachedContext;
	/** What plugins and callers are given of the context: never the context. */
	readonly view: Attachment;
	readonly onClose: () => void;
	/** Plugins whose `attach` was started for this context, in order. */
	readonly runtimes: PluginRuntime<unknown>[];
	/** Settles once the attach has finished installing, however it ended. */
	readonly installing: Promise<void>;
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
		clock,
		timeoutMs: options.pageTimeoutMs ?? 2_000,
	});
	const sockets = createSocketRouter({
		timeline,
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
		pageId,
		wait: {
			timeout: options.wait?.timeout ?? 5_000,
			interval: options.wait?.interval ?? 25,
		},
	});

	/**
	 * Undo an attach. One still installing is waited for first: undoing half
	 * of it would leave the rest installed for good. Every step runs even when
	 * one fails: a plugin's bug must not leak a route.
	 */
	const detachOne = async (context: ContextPort): Promise<void> => {
		const entry = attached.get(context);
		if (entry === undefined) return;
		attached.delete(context);
		await entry.installing;
		context.off("close", entry.onClose);
		const { attachment, view } = entry;
		await runAll([
			...[...entry.runtimes]
				.reverse()
				.map((runtime) => () => runtime.detach?.(view)),
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
			return [...attached.values()].map((entry) => entry.view);
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
			// The context stays with the stage and its engines. A plugin gets its
			// id, its base URL and a jar that only reads and adds cookies: what
			// it could do with the context itself would go round the engines.
			const cookies: CookieJarPort = Object.freeze({
				cookies: (urls?: string | string[]) => context.cookies(urls),
				addCookies: (init: CookieInit[]) => context.addCookies(init),
			});
			const view: Attachment = Object.freeze({
				id: contextId(),
				baseURL: attachOptions.baseURL ?? options.baseURL,
				cookies,
			});
			const attachment: AttachedContext = { ...view, context };
			// A closed context takes its routes with it; forgetting it here keeps
			// the next sync from evaluating in pages that no longer exist.
			const onClose = () => {
				detachOne(context).catch((error: unknown) =>
					log.debug("detaching a closed context failed", {}, error),
				);
			};
			const started: PluginRuntime<unknown>[] = [];
			const installing = (async () => {
				await pages.attach(attachment);
				await http.attach(attachment);
				await sockets.attach(attachment);
				for (const runtime of runtimes) {
					started.push(runtime);
					await runtime.attach?.(view);
				}
			})();
			const entry: Attached = {
				attachment,
				view,
				onClose,
				runtimes: started,
				installing: installing.then(
					() => undefined,
					() => undefined,
				),
			};
			attached.set(context, entry);
			context.on("close", onClose);
			try {
				await installing;
			} catch (error) {
				// Half-attached is worse than not attached: undo what took, so the
				// caller can fix the cause and attach this context again.
				await detachOne(context).catch((secondary: unknown) =>
					log.debug("undoing a failed attach failed", {}, secondary),
				);
				throw error;
			}
			if (attached.get(context) !== entry)
				// Detached, or closed, while it was installing: that detach is
				// undoing all of it, so this attach did not take.
				throw new WirestageError(
					"INVALID_STATE",
					"the context was detached while it was being attached",
				);
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

	// The services, not the engines behind them: attaching, detaching and
	// settling are the stage's to do.
	const services = {
		http: Object.freeze({ add: http.add }),
		sockets: Object.freeze({ add: sockets.add, prepare: sockets.prepare }),
		pages: Object.freeze({
			register: pages.register,
			command: pages.command,
			refresh: pages.refresh,
			pageId: pages.pageId,
		}),
	} satisfies Pick<PluginContext, "http" | "sockets" | "pages">;

	/** Set a plugin up, and whatever it builds on first. */
	const mount = (plugin: AnyWirePlugin): PluginRuntime<unknown> => {
		const context: PluginContext = {
			name: plugin.name,
			timeline,
			clock,
			log: createScopedLogger(plugin.scope ?? "Plugin"),
			...services,
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
