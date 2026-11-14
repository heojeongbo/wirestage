import type { PageModuleEnv } from "../../../entities/plugin/index.js";
import type {
	RtcInjectArgs,
	RtcPageConfig,
	RtcPageState,
} from "../model/types.js";

/**
 * Runs INSIDE the page (serialized): self-contained, `function` declaration.
 *
 * Three hooks, each placed so the page's own code is untouched:
 *
 * - `RTCDataChannel.prototype.send` is wrapped, so every send on every channel
 *   is seen as it leaves — the last point the page and a real peer agree on.
 * - `createDataChannel` is wrapped and the constructor is replaced by one that
 *   adds a `datachannel` listener first, so every channel — page-created or
 *   remote-created — gets OUR `message` listener before the page's. Only a
 *   first listener can `stopImmediatePropagation()` the rest, which is what
 *   suppression needs; wrapping `onmessage` instead would race the page's own
 *   assignment of it.
 * - Injected messages are dispatched as real `MessageEvent`s on the channel,
 *   so the page's handlers cannot tell them from the peer's.
 *
 * All three come off again when the stage detaches.
 */
export function installWebRtc(
	env: PageModuleEnv<RtcPageState, RtcPageConfig>,
): void {
	const win = env.window;
	const PeerConnection = win.RTCPeerConnection;
	const DataChannel = win.RTCDataChannel;
	if (typeof PeerConnection !== "function" || typeof DataChannel !== "function")
		return;
	const config = env.config;
	let suppressIn = new Set<string>();
	let blockOut = new Set<string>();
	const open = new Map<string, Set<RTCDataChannel>>();
	const watched = new WeakSet<RTCDataChannel>();
	const injected = new WeakSet<Event>();
	/** Listeners added to the page's channels, to take off on detach. */
	const unwatch: (() => void)[] = [];

	const wanted = (label: string) =>
		config.labels === null || config.labels.includes(label);

	const emit = (
		type: string,
		label: string,
		data: unknown,
		extra: Record<string, unknown> = {},
	) => {
		const meta: Record<string, unknown> = { label, ...extra };
		let payload: { data?: string; text?: string } = {};
		if (typeof data === "string") payload = { text: data };
		else if (data instanceof ArrayBuffer)
			payload = { data: env.encode(new Uint8Array(data)) };
		else if (ArrayBuffer.isView(data))
			payload = {
				data: env.encode(
					new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
				),
			};
		// A Blob would need an async read, which would put it out of order with
		// the frames around it; it is recorded as skipped instead.
		else if (data !== undefined) meta["skipped"] = "blob";
		env.emit({ type, at: env.now(), ...payload, meta });
	};

	const watch = (channel: RTCDataChannel) => {
		if (watched.has(channel)) return;
		watched.add(channel);
		const label = channel.label;
		const track = () => {
			let set = open.get(label);
			if (set === undefined) {
				set = new Set();
				open.set(label, set);
			}
			set.add(channel);
			if (config.lifecycle && wanted(label))
				emit("open", label, undefined, { id: channel.id });
		};
		const untrack = () => {
			open.get(label)?.delete(channel);
			if (config.lifecycle && wanted(label))
				emit("close", label, undefined, { id: channel.id });
		};
		const onMessage = (event: MessageEvent) => {
			const mine = injected.has(event);
			// What the test injects is the point of suppressing the peer:
			// silence the real one, speak in its place.
			if (suppressIn.has(label) && !mine) {
				event.stopImmediatePropagation();
				if (wanted(label)) emit("suppressed", label, event.data);
				return;
			}
			if (config.recordIn && wanted(label))
				emit("in", label, event.data, mine ? { injected: true } : {});
		};
		if (channel.readyState === "open") track();
		else channel.addEventListener("open", track, { once: true });
		channel.addEventListener("close", untrack, { once: true });
		channel.addEventListener("message", onMessage);
		unwatch.push(() => {
			channel.removeEventListener("open", track);
			channel.removeEventListener("close", untrack);
			channel.removeEventListener("message", onMessage);
		});
	};

	const send = DataChannel.prototype.send;
	DataChannel.prototype.send = function wirestageSend(
		this: RTCDataChannel,
		data: never,
	): void {
		const label = this.label;
		if (blockOut.has(label)) {
			if (wanted(label)) emit("blocked", label, data);
			return;
		}
		// Recorded once it has left: a send the browser refuses (a channel not
		// open yet) throws here, and must not land on the timeline as sent.
		send.call(this, data);
		if (config.recordOut && wanted(label)) emit("out", label, data);
	};

	const createDataChannel = PeerConnection.prototype.createDataChannel;
	PeerConnection.prototype.createDataChannel = function wirestageCreate(
		this: RTCPeerConnection,
		label: string,
		init?: RTCDataChannelInit,
	): RTCDataChannel {
		const channel = createDataChannel.call(this, label, init);
		watch(channel);
		return channel;
	};

	function WirestagePeerConnection(
		...args: ConstructorParameters<typeof RTCPeerConnection>
	): RTCPeerConnection {
		// `new.target`, so a page's own subclass still gets its prototype —
		// and, as with the real constructor, calling it without `new` throws.
		const connection: RTCPeerConnection = Reflect.construct(
			PeerConnection,
			args,
			new.target as never,
		);
		connection.addEventListener("datachannel", (event: RTCDataChannelEvent) =>
			watch(event.channel),
		);
		return connection;
	}
	// Same prototype, so `instanceof RTCPeerConnection` and the patched
	// methods above keep working; statics such as generateCertificate come
	// through the prototype chain of the function itself.
	WirestagePeerConnection.prototype = PeerConnection.prototype;
	Object.setPrototypeOf(WirestagePeerConnection, PeerConnection);
	win.RTCPeerConnection =
		WirestagePeerConnection as unknown as typeof RTCPeerConnection;

	env.onState((state) => {
		suppressIn = new Set(state.suppressIn);
		blockOut = new Set(state.blockOut);
	});
	env.onCommand("inject", (args: RtcInjectArgs) => {
		let delivered = 0;
		for (const channel of open.get(args.label) ?? []) {
			if (channel.readyState !== "open") continue;
			let data: unknown = args.text;
			if (data === undefined) {
				const buffer = env.decode(args.data ?? "").buffer as ArrayBuffer;
				data = channel.binaryType === "blob" ? new win.Blob([buffer]) : buffer;
			}
			const event = new win.MessageEvent("message", { data });
			injected.add(event);
			channel.dispatchEvent(event);
			delivered += 1;
		}
		return delivered;
	});
	env.onDetach(() => {
		DataChannel.prototype.send = send;
		PeerConnection.prototype.createDataChannel = createDataChannel;
		win.RTCPeerConnection = PeerConnection;
		for (const undo of unwatch.splice(0)) undo();
		suppressIn = new Set();
		blockOut = new Set();
	});
}
