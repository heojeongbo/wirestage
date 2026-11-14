/**
 * Just enough of RTCPeerConnection and RTCDataChannel for the WebRTC page
 * module: event dispatch, `send` on the prototype (so the module can wrap
 * it) that throws on a channel that is not open, as a browser's does, and
 * helpers to play the remote peer.
 */

/** What a browser throws from `send()` on a channel that is not open. */
function sendOn(channel: FakeDataChannel, data: unknown): void {
	if (channel.readyState !== "open")
		throw new DOMException(
			"RTCDataChannel.readyState is not 'open'",
			"InvalidStateError",
		);
	channel.sent.push(data);
}

export class FakeDataChannel extends EventTarget {
	static nextId = 0;
	readonly label: string;
	readonly id: number;
	readyState: RTCDataChannelState = "connecting";
	binaryType: BinaryType = "arraybuffer";
	readonly sent: unknown[] = [];

	constructor(label: string) {
		super();
		this.label = label;
		this.id = FakeDataChannel.nextId++;
	}
	send(data: unknown): void {
		sendOn(this, data);
	}
	open(): this {
		this.readyState = "open";
		this.dispatchEvent(new Event("open"));
		return this;
	}
	close(): void {
		this.readyState = "closed";
		this.dispatchEvent(new Event("close"));
	}
	/** The remote peer sends `data`. */
	receive(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
}

export class FakePeerConnection extends EventTarget {
	static certificates = 0;
	readonly config: unknown;
	constructor(config?: unknown) {
		super();
		this.config = config;
	}
	createDataChannel(label: string, _init?: unknown): FakeDataChannel {
		return new FakeDataChannel(label);
	}
	/** The remote peer opens a channel. */
	remoteChannel(label: string): FakeDataChannel {
		const channel = new FakeDataChannel(label);
		const event = new Event("datachannel") as Event & {
			channel: FakeDataChannel;
		};
		event.channel = channel;
		this.dispatchEvent(event);
		return channel;
	}
	static generateCertificate(): number {
		return ++FakePeerConnection.certificates;
	}
}

/** A fresh pair of classes, so one test's prototype patch never leaks into the next. */
export function freshRtcClasses(): {
	PeerConnection: typeof FakePeerConnection;
	DataChannel: typeof FakeDataChannel;
} {
	class DataChannel extends FakeDataChannel {}
	DataChannel.prototype.send = function send(
		this: FakeDataChannel,
		data: unknown,
	) {
		sendOn(this, data);
	};
	class PeerConnection extends FakePeerConnection {
		override createDataChannel(label: string): FakeDataChannel {
			return new DataChannel(label);
		}
		override remoteChannel(label: string): FakeDataChannel {
			const channel = new DataChannel(label);
			const event = new Event("datachannel") as Event & {
				channel: FakeDataChannel;
			};
			event.channel = channel;
			this.dispatchEvent(event);
			return channel;
		}
	}
	return { PeerConnection, DataChannel };
}
