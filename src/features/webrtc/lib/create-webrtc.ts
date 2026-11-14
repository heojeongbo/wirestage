import {
	definePlugin,
	type WirePlugin,
} from "../../../entities/plugin/index.js";
import { toBase64, toBytes } from "../../../shared/lib/bytes/index.js";
import { WirestageError } from "../../../shared/lib/errors/index.js";
import type {
	RtcInjectArgs,
	RtcPageConfig,
	RtcPageState,
	WebRtcApi,
	WebRtcOptions,
} from "../model/types.js";
import { installWebRtc } from "./rtc-page-module.js";
import { toFrame } from "./to-frame.js";

/** The calls in force on each label; a label with none is not suppressed. */
type Suppressions = Map<string, Set<symbol>>;

/**
 * WebRTC data channels: record what the page sends and receives, drop
 * messages on one channel while it stays open, and inject messages as the
 * remote peer.
 */
export function webrtc(
	options: WebRtcOptions = {},
): WirePlugin<"webrtc", WebRtcApi> {
	return definePlugin({
		name: "webrtc",
		scope: "Rtc",
		setup(context) {
			const { name } = context;
			const suppressIn: Suppressions = new Map();
			const blockOut: Suppressions = new Map();
			const directions = options.record ?? ["in", "out"];
			const config: RtcPageConfig = {
				labels: options.labels ?? null,
				recordIn: directions.includes("in"),
				recordOut: directions.includes("out"),
				lifecycle: options.lifecycle ?? true,
			};
			context.pages.register<RtcPageState, RtcPageConfig>({
				id: name,
				install: installWebRtc,
				config,
				state: () => ({
					suppressIn: [...suppressIn.keys()],
					blockOut: [...blockOut.keys()],
				}),
				receive(entries, origin) {
					for (const entry of entries)
						context.timeline.append(toFrame(name, entry, origin));
				},
			});
			const refresh = () => context.pages.refresh(name);
			const hold = (held: Suppressions, label: string, token: symbol) => {
				const tokens = held.get(label) ?? new Set();
				tokens.add(token);
				held.set(label, tokens);
			};
			const release = (held: Suppressions, label: string, token: symbol) => {
				const tokens = held.get(label);
				// Gone already when `restore` cleared the label first.
				if (tokens === undefined) return;
				tokens.delete(token);
				if (tokens.size === 0) held.delete(label);
			};

			const api: WebRtcApi = {
				async frames(filter = {}) {
					await context.sync();
					return context.timeline.frames({ ...filter, protocol: name });
				},
				async messages(label, messageOptions = {}) {
					await context.sync();
					return context.timeline.frames({
						protocol: name,
						kind: "message",
						endpoint: label,
						...(messageOptions.direction === undefined
							? {}
							: { direction: messageOptions.direction }),
					});
				},
				async suppress(label, suppressOptions = {}) {
					const direction = suppressOptions.direction ?? "in";
					const token = Symbol(label);
					if (direction !== "out") hold(suppressIn, label, token);
					if (direction !== "in") hold(blockOut, label, token);
					await refresh();
					return async () => {
						release(suppressIn, label, token);
						release(blockOut, label, token);
						await refresh();
					};
				},
				async restore(label) {
					if (label === undefined) {
						suppressIn.clear();
						blockOut.clear();
					} else {
						suppressIn.delete(label);
						blockOut.delete(label);
					}
					await refresh();
				},
				async inject(label, data, injectOptions = {}) {
					const args: RtcInjectArgs =
						typeof data === "string"
							? { label, text: data }
							: { label, data: toBase64(toBytes(data)) };
					const results = await context.pages.command(
						name,
						"inject",
						args,
						injectOptions.page === undefined
							? {}
							: { page: context.pages.pageId(injectOptions.page) },
					);
					return results.reduce<number>(
						(sum, delivered) => sum + Number(delivered),
						0,
					);
				},
				async waitForChannel(label, waitOptions = {}) {
					if (!config.lifecycle)
						// It would only ever time out: there is no open frame to wait for.
						throw new WirestageError(
							"INVALID_STATE",
							`waitForChannel("${label}") needs lifecycle frames, and this plugin was created with \`lifecycle: false\``,
						);
					const [frame] = await context.waitFor(
						{
							protocol: name,
							kind: "lifecycle",
							endpoint: label,
							where: (f) => f.meta["event"] === "open",
						},
						waitOptions.timeout === undefined
							? {}
							: { timeout: waitOptions.timeout },
					);
					return frame as NonNullable<typeof frame>;
				},
			};
			return { api };
		},
	});
}
