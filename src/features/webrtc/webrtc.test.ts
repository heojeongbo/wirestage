import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createFakeContext,
	type FakeFrame,
	type FakePage,
} from "../../__fixtures__/fake-playwright.js";
import {
	type FakeDataChannel,
	freshRtcClasses,
} from "../../__fixtures__/fake-rtc.js";
import type { PageEntry, PageModuleEnv } from "../../entities/plugin/index.js";
import { named } from "../../entities/plugin/index.js";
import { createStage } from "../../widgets/stage/index.js";
import { webrtc } from "./index.js";
import { installWebRtc } from "./lib/rtc-page-module.js";
import { toFrame } from "./lib/to-frame.js";
import type { RtcPageConfig, RtcPageState } from "./model/types.js";

afterEach(() => vi.restoreAllMocks());

const ALL: RtcPageConfig = {
	labels: null,
	recordIn: true,
	recordOut: true,
	lifecycle: true,
};

/** Install the page module directly (in this realm, so it counts for coverage). */
function install(
	config: Partial<RtcPageConfig> = {},
	scope?: Record<string, unknown>,
) {
	const { PeerConnection, DataChannel } = freshRtcClasses();
	const window = (scope ?? {
		RTCPeerConnection: PeerConnection,
		RTCDataChannel: DataChannel,
		MessageEvent,
		Blob,
	}) as unknown as Window & typeof globalThis;
	const entries: PageEntry[] = [];
	const commands = new Map<string, (args: never) => unknown>();
	const stateHandlers: ((state: RtcPageState) => void)[] = [];
	const detachHandlers: (() => void)[] = [];
	const env: PageModuleEnv<RtcPageState, RtcPageConfig> = {
		window,
		config: { ...ALL, ...config },
		emit: (entry) => entries.push(entry),
		now: () => 42,
		encode: (bytes) => Buffer.from(bytes).toString("base64"),
		decode: (text) => new Uint8Array(Buffer.from(text, "base64")),
		onCommand: (op, handler) => commands.set(op, handler),
		onState: (handler) => stateHandlers.push(handler),
		onDetach: (handler) => detachHandlers.push(handler),
	};
	installWebRtc(env);
	const Patched = window.RTCPeerConnection as unknown as new (
		config?: unknown,
	) => InstanceType<typeof PeerConnection>;
	return {
		window,
		entries,
		Patched,
		PeerConnection,
		DataChannel,
		command: (op: string, args: unknown) =>
			(commands.get(op) as (a: unknown) => unknown)(args),
		setState: (state: RtcPageState) => {
			for (const handler of stateHandlers) handler(state);
		},
		detach: () => {
			for (const handler of detachHandlers) handler();
		},
	};
}

describe("webrtc page module", () => {
	it("does nothing where WebRTC is missing", () => {
		const scope: Record<string, unknown> = {};
		install({}, scope);
		expect(scope).toEqual({});
	});

	it("keeps instanceof, statics and the constructor's arguments intact", () => {
		const { Patched, PeerConnection } = install();
		const connection = new Patched({ iceServers: [] });
		expect(connection).toBeInstanceOf(PeerConnection);
		expect(connection.config).toEqual({ iceServers: [] });
		expect(
			(
				Patched as unknown as { generateCertificate(): number }
			).generateCertificate(),
		).toBeGreaterThan(0);
	});

	it("lets the page subclass the connection, methods and all", () => {
		const { Patched, entries } = install();
		// What an app's own wrapper, or a library's, does.
		class AppConnection extends Patched {
			greet(): string {
				return "from the subclass";
			}
		}
		const connection = new AppConnection({ iceServers: [] });
		expect(connection).toBeInstanceOf(AppConnection);
		expect(connection.greet()).toBe("from the subclass");
		expect(connection.config).toEqual({ iceServers: [] });
		// And its channels are watched like any other's.
		connection.remoteChannel("telemetry").open();
		expect(entries.map((e) => e.type)).toEqual(["open"]);
		// Like the real constructor, it is not callable without `new`.
		expect(() => (Patched as unknown as () => unknown)()).toThrow(TypeError);
	});

	it("records sends of every payload kind, once they have left", () => {
		const { Patched, entries } = install();
		const channel = new Patched().createDataChannel(
			"room/cursor",
		) as FakeDataChannel;
		channel.open();
		channel.send("text");
		channel.send(new Uint8Array([1, 2, 3]).buffer);
		channel.send(new Uint8Array([9, 1, 2, 3]).subarray(1));
		channel.send(new Blob(["x"]));
		expect(channel.sent).toHaveLength(4);
		expect(
			entries.map((e) => [e.type, e.text ?? e.data, e.meta?.["skipped"]]),
		).toEqual([
			["open", undefined, undefined],
			["out", "text", undefined],
			["out", "AQID", undefined],
			["out", "AQID", undefined],
			["out", undefined, "blob"],
		]);
		expect(entries[0]?.meta).toEqual({ label: "room/cursor", id: channel.id });
	});

	it("does not record a send the browser refused", () => {
		const { Patched, entries } = install();
		const channel = new Patched().createDataChannel(
			"room/cursor",
		) as FakeDataChannel;
		// Not open yet: the browser throws, and nothing left the page.
		expect(() => channel.send("too early")).toThrow(/not 'open'/);
		expect(entries).toEqual([]);
	});

	it("records inbound messages on page- and remote-created channels, once each", () => {
		const { Patched, entries } = install();
		const connection = new Patched();
		const local = connection.createDataChannel(
			"room/control",
		) as FakeDataChannel;
		local.open();
		local.receive(new Uint8Array([7]).buffer);
		const remote = connection.remoteChannel("room/presence");
		remote.open();
		remote.receive("state");
		// A second datachannel event for the same channel must not double-record.
		const again = new Event("datachannel") as Event & {
			channel: FakeDataChannel;
		};
		again.channel = remote;
		connection.dispatchEvent(again);
		remote.receive("again");
		expect(
			entries.filter((e) => e.type === "in").map((e) => e.data ?? e.text),
		).toEqual(["Bw==", "state", "again"]);
	});

	it("tracks channels that are already open, and their close", () => {
		const { Patched, entries, DataChannel } = install();
		const connection = new Patched();
		const open = new DataChannel("ready");
		open.readyState = "open";
		const remote = new Event("datachannel") as Event & {
			channel: FakeDataChannel;
		};
		remote.channel = open;
		connection.dispatchEvent(remote);
		open.close();
		expect(entries.map((e) => e.type)).toEqual(["open", "close"]);
	});

	it("honours the label filter and the recording switches", () => {
		const { Patched, entries } = install({
			labels: ["wanted"],
			recordIn: false,
			recordOut: false,
			lifecycle: false,
		});
		const connection = new Patched();
		const wanted = connection.createDataChannel("wanted") as FakeDataChannel;
		const other = connection.createDataChannel("other") as FakeDataChannel;
		wanted.open();
		other.open();
		wanted.send("a");
		wanted.receive("b");
		other.send("c");
		wanted.close();
		expect(entries).toEqual([]);
		const filtered = install({ labels: ["wanted"] });
		const channel = new filtered.Patched().createDataChannel(
			"other",
		) as FakeDataChannel;
		channel.open();
		channel.send("x");
		channel.receive("y");
		channel.close();
		expect(filtered.entries).toEqual([]);
	});

	it("suppresses inbound messages before the page's own listeners", () => {
		const { Patched, entries, setState } = install({
			labels: ["room/presence", "quiet"],
		});
		const connection = new Patched();
		const channel = connection.remoteChannel("room/presence");
		const appSaw: unknown[] = [];
		channel.addEventListener("message", (event) =>
			appSaw.push((event as MessageEvent).data),
		);
		channel.open();
		setState({ suppressIn: ["room/presence", "ignored"], blockOut: [] });
		channel.receive("dropped");
		expect(appSaw).toEqual([]);
		expect(entries.at(-1)).toMatchObject({
			type: "suppressed",
			text: "dropped",
		});
		setState({ suppressIn: [], blockOut: [] });
		channel.receive("delivered");
		expect(appSaw).toEqual(["delivered"]);
		// A suppressed channel outside the label filter is still silenced, quietly.
		const unlisted = install({ labels: ["x"] });
		const hidden = new unlisted.Patched().remoteChannel("y");
		hidden.open();
		unlisted.setState({ suppressIn: ["y"], blockOut: [] });
		hidden.receive("z");
		expect(unlisted.entries).toEqual([]);
	});

	it("blocks sends without calling the real send", () => {
		const { Patched, entries, setState } = install({
			labels: ["room/cursor"],
		});
		const connection = new Patched();
		const channel = connection.createDataChannel(
			"room/cursor",
		) as FakeDataChannel;
		const other = connection.createDataChannel("other") as FakeDataChannel;
		channel.open();
		other.open();
		setState({ suppressIn: [], blockOut: ["room/cursor", "other"] });
		channel.send("never");
		other.send("never either");
		expect(channel.sent).toEqual([]);
		expect(other.sent).toEqual([]);
		expect(entries.map((e) => e.type)).toEqual(["open", "blocked"]);
	});

	it("injects messages as the remote peer, as text, bytes or a Blob", async () => {
		const { Patched, entries, command } = install();
		const connection = new Patched();
		const channel = connection.createDataChannel(
			"room/control",
		) as FakeDataChannel;
		const blobs = connection.createDataChannel(
			"room/control",
		) as FakeDataChannel;
		blobs.binaryType = "blob";
		const closed = connection.createDataChannel(
			"room/control",
		) as FakeDataChannel;
		const appSaw: unknown[] = [];
		channel.addEventListener("message", (e) =>
			appSaw.push((e as MessageEvent).data),
		);
		blobs.addEventListener("message", (e) =>
			appSaw.push((e as MessageEvent).data),
		);
		channel.open();
		blobs.open();
		closed.open();
		closed.readyState = "closing";
		expect(command("inject", { label: "room/control", text: "hi" })).toBe(2);
		expect(command("inject", { label: "room/control", data: "AQI=" })).toBe(2);
		expect(command("inject", { label: "room/control" })).toBe(2);
		expect(command("inject", { label: "nobody", text: "x" })).toBe(0);
		expect(appSaw[0]).toBe("hi");
		expect(new Uint8Array(appSaw[2] as ArrayBuffer)).toEqual(
			new Uint8Array([1, 2]),
		);
		expect(appSaw[3]).toBeInstanceOf(Blob);
		expect(new Uint8Array(await (appSaw[3] as Blob).arrayBuffer())).toEqual(
			new Uint8Array([1, 2]),
		);
		expect(
			entries
				.filter((e) => e.type === "in")
				.every((e) => e.meta?.["injected"] === true),
		).toBe(true);
	});

	it("lets an injected message through a suppressed channel", () => {
		// Silence the real peer, speak in its place: the reason to do both.
		const { Patched, entries, setState, command } = install();
		const channel = new Patched().remoteChannel("telemetry");
		const appSaw: unknown[] = [];
		channel.addEventListener("message", (e) =>
			appSaw.push((e as MessageEvent).data),
		);
		channel.open();
		setState({ suppressIn: ["telemetry"], blockOut: [] });
		channel.receive("from the real peer");
		expect(command("inject", { label: "telemetry", text: "synthetic" })).toBe(
			1,
		);
		expect(appSaw).toEqual(["synthetic"]);
		expect(entries.map((e) => [e.type, e.text])).toEqual([
			["open", undefined],
			["suppressed", "from the real peer"],
			["in", "synthetic"],
		]);
	});

	it("puts everything back when the stage detaches", () => {
		const {
			Patched,
			PeerConnection,
			DataChannel,
			window,
			entries,
			setState,
			detach,
		} = install();
		const realSend = DataChannel.prototype.send;
		const connection = new Patched();
		const pending = connection.createDataChannel("later") as FakeDataChannel;
		const channel = connection.createDataChannel("live") as FakeDataChannel;
		const appSaw: unknown[] = [];
		channel.addEventListener("message", (e) =>
			appSaw.push((e as MessageEvent).data),
		);
		channel.open();
		setState({ suppressIn: ["live"], blockOut: ["live"] });
		entries.length = 0;
		detach();
		// The page has its own WebRTC back...
		expect(window.RTCPeerConnection).toBe(PeerConnection);
		expect(DataChannel.prototype.send).not.toBe(realSend);
		expect(
			(
				new window.RTCPeerConnection() as unknown as InstanceType<
					typeof PeerConnection
				>
			).createDataChannel("new"),
		).toBeInstanceOf(DataChannel);
		// ...its channels are neither recorded nor suppressed any more...
		channel.send("after");
		channel.receive("after");
		pending.open();
		channel.close();
		expect(channel.sent).toEqual(["after"]);
		expect(appSaw).toEqual(["after"]);
		// ...and nothing more is said about them.
		expect(entries).toEqual([]);
	});
});

describe("rtc entry to frame", () => {
	const origin = { page: "p1", context: "c1" };

	it("says who produced each entry, and names its event or its reason", () => {
		const cases: [string, string, string, string, object][] = [
			["out", "message", "out", "page", {}],
			["in", "message", "in", "network", {}],
			["open", "lifecycle", "none", "page", { event: "open" }],
			["close", "lifecycle", "none", "page", { event: "close" }],
			["suppressed", "fault", "in", "stub", { reason: "suppressed" }],
			["blocked", "fault", "out", "stub", { reason: "blocked" }],
			// The page module itself failed: the page runtime's own entry.
			["error", "fault", "none", "page", { reason: "error" }],
		];
		for (const [type, kind, direction, source, extra] of cases)
			expect(
				toFrame("webrtc", { type, at: 1, meta: { label: "l" } }, origin),
			).toEqual({
				protocol: "webrtc",
				kind,
				direction,
				source,
				endpoint: "l",
				at: 1,
				meta: { label: "l", ...extra },
				page: "p1",
				context: "c1",
			});
	});

	it("files a message the test injected under the test, not the peer", () => {
		expect(
			toFrame(
				"webrtc",
				{ type: "in", at: 1, text: "x", meta: { label: "l", injected: true } },
				origin,
			),
		).toMatchObject({ direction: "in", source: "test" });
	});

	it("carries binary, text or no payload, and survives a missing label", () => {
		expect(
			toFrame("rtc", { type: "out", at: 1, data: "AQ==" }, origin).data,
		).toEqual(new Uint8Array([1]));
		expect(toFrame("rtc", { type: "out", at: 1, text: "t" }, origin).data).toBe(
			"t",
		);
		const bare = toFrame(
			"rtc",
			{ type: "error", at: 1, meta: { label: 5 } },
			origin,
		);
		expect(bare.data).toBeUndefined();
		expect(bare.endpoint).toBe("");
		expect(toFrame("rtc", { type: "open", at: 1 }, origin)).toMatchObject({
			protocol: "rtc",
			endpoint: "",
			meta: { event: "open" },
		});
	});
});

/** A frame whose scope has WebRTC, loaded through the real init script. */
function webrtcFrame(frame: FakePage | FakeFrame) {
	const { PeerConnection, DataChannel } = freshRtcClasses();
	Object.assign(frame.scope, {
		RTCPeerConnection: PeerConnection,
		RTCDataChannel: DataChannel,
		MessageEvent,
		Blob,
	});
	frame.load();
	return {
		PeerConnection,
		Connection: frame.scope[
			"RTCPeerConnection"
		] as unknown as new () => InstanceType<typeof PeerConnection>,
	};
}

describe("webrtc plugin", () => {
	async function stageWithPage(options: Parameters<typeof webrtc>[0] = {}) {
		const stage = createStage({ plugins: [webrtc(options)] });
		const context = createFakeContext({ disposables: true });
		await stage.attach(context);
		const page = context.newPage();
		const { Connection, PeerConnection } = webrtcFrame(page);
		return { stage, context, page, Connection, PeerConnection };
	}

	it("records a session the page runs, end to end through the init script", async () => {
		const { stage, Connection } = await stageWithPage();
		const channel = new Connection().createDataChannel(
			"room/cursor",
		) as FakeDataChannel;
		channel.open();
		channel.send(new Uint8Array([1, 2]).buffer);
		channel.receive("ack");
		const frames = await stage.webrtc.frames();
		// The app's sends are the page's; what arrives is the peer's.
		expect(
			frames.map((f) => [f.kind, f.direction, f.source, f.endpoint]),
		).toEqual([
			["lifecycle", "none", "page", "room/cursor"],
			["message", "out", "page", "room/cursor"],
			["message", "in", "network", "room/cursor"],
		]);
		expect(frames[1]?.payload.bytes()).toEqual(new Uint8Array([1, 2]));
		expect(frames[1]?.page).toBe("p1");
		expect((await stage.webrtc.messages("room/cursor")).length).toBe(2);
		expect(
			(await stage.webrtc.messages("room/cursor", { direction: "in" })).map(
				(f) => f.payload.text(),
			),
		).toEqual(["ack"]);
		expect((await stage.webrtc.frames({ kind: "lifecycle" })).length).toBe(1);
		await stage.dispose();
	});

	it("suppresses and restores, per call and per label", async () => {
		const { stage, Connection } = await stageWithPage();
		const connection = new Connection();
		const inbound = connection.remoteChannel("telemetry");
		const outbound = connection.createDataChannel(
			"commands",
		) as FakeDataChannel;
		inbound.open();
		outbound.open();
		const restoreIn = await stage.webrtc.suppress("telemetry");
		const restoreOut = await stage.webrtc.suppress("commands", {
			direction: "out",
		});
		inbound.receive("dropped");
		outbound.send("blocked");
		expect(outbound.sent).toEqual([]);
		await restoreIn();
		await restoreOut();
		inbound.receive("delivered");
		outbound.send("sent");
		expect(outbound.sent).toEqual(["sent"]);
		await stage.webrtc.suppress("telemetry", { direction: "both" });
		await stage.webrtc.restore("telemetry");
		await stage.webrtc.suppress("telemetry", { direction: "both" });
		await stage.webrtc.restore();
		inbound.receive("still delivered");
		const faults = await stage.webrtc.frames({ kind: "fault" });
		// A fault says its reason, as every protocol's do, and is the stub's.
		expect(faults.map((f) => [f.meta["reason"], f.source])).toEqual([
			["suppressed", "stub"],
			["blocked", "stub"],
		]);
		await stage.dispose();
	});

	it("undoes exactly the call it was returned by", async () => {
		const { stage, Connection } = await stageWithPage();
		const channel = new Connection().remoteChannel("telemetry");
		const appSaw: unknown[] = [];
		channel.addEventListener("message", (e) =>
			appSaw.push((e as MessageEvent).data),
		);
		channel.open();
		const undoFirst = await stage.webrtc.suppress("telemetry");
		const undoSecond = await stage.webrtc.suppress("telemetry");
		await undoFirst();
		// The second call is still in force.
		channel.receive("still suppressed");
		expect(appSaw).toEqual([]);
		// Undoing the same call twice does not lift the other.
		await undoFirst();
		channel.receive("still suppressed");
		expect(appSaw).toEqual([]);
		await undoSecond();
		channel.receive("delivered");
		expect(appSaw).toEqual(["delivered"]);
		// After a restore, an undo from before it has nothing left to lift —
		// and must not lift a suppression made since.
		const stale = await stage.webrtc.suppress("telemetry");
		await stage.webrtc.restore("telemetry");
		await stage.webrtc.suppress("telemetry");
		await stale();
		channel.receive("suppressed again");
		expect(appSaw).toEqual(["delivered"]);
		await stage.dispose();
	});

	it("injects into one page or all, as text or bytes, and counts as the test's", async () => {
		const { stage, context, Connection, page } = await stageWithPage();
		const channel = new Connection().createDataChannel(
			"room/control",
		) as FakeDataChannel;
		channel.open();
		const second = context.newPage();
		(
			new (webrtcFrame(second).Connection)().createDataChannel(
				"room/control",
			) as FakeDataChannel
		).open();
		expect(await stage.webrtc.inject("room/control", "everyone")).toBe(2);
		expect(
			await stage.webrtc.inject("room/control", new Uint8Array([5]), { page }),
		).toBe(1);
		const injected = await stage.webrtc.messages("room/control", {
			direction: "in",
		});
		expect(injected.map((f) => [f.meta["injected"], f.source])).toEqual([
			[true, "test"],
			[true, "test"],
			[true, "test"],
		]);
		// A page the init script never ran in has no channels to count.
		context.newPage();
		expect(await stage.webrtc.inject("room/control", "x")).toBe(2);
		await stage.dispose();
	});

	it("reaches a channel inside an iframe", async () => {
		const { stage, page } = await stageWithPage();
		const iframe = page.addFrame();
		const channel = new (webrtcFrame(iframe).Connection)().remoteChannel(
			"telemetry",
		);
		const appSaw: unknown[] = [];
		channel.addEventListener("message", (e) =>
			appSaw.push((e as MessageEvent).data),
		);
		channel.open();
		await stage.webrtc.suppress("telemetry");
		channel.receive("dropped in the iframe");
		expect(appSaw).toEqual([]);
		expect(await stage.webrtc.inject("telemetry", "to the iframe")).toBe(1);
		expect(appSaw).toEqual(["to the iframe"]);
		// A read flushes the iframe's buffer too.
		expect((await stage.webrtc.frames()).map((f) => f.kind)).toEqual([
			"lifecycle",
			"fault",
			"message",
		]);
		await stage.dispose();
	});

	it("waits for a channel to open", async () => {
		const { stage, Connection } = await stageWithPage();
		const waiting = stage.webrtc.waitForChannel("late", { timeout: 2_000 });
		const channel = new Connection().createDataChannel(
			"late",
		) as FakeDataChannel;
		channel.open();
		await expect(waiting).resolves.toMatchObject({
			endpoint: "late",
			meta: { event: "open" },
		});
		await expect(stage.webrtc.waitForChannel("late")).resolves.toMatchObject({
			endpoint: "late",
		});
		await stage.dispose();
	});

	it("says at once that waiting for a channel needs lifecycle frames", async () => {
		const { stage } = await stageWithPage({ lifecycle: false });
		await expect(stage.webrtc.waitForChannel("x")).rejects.toMatchObject({
			code: "INVALID_STATE",
			message: expect.stringContaining("lifecycle: false"),
		});
		await stage.dispose();
	});

	it("records only the configured labels and directions", async () => {
		const { stage, Connection } = await stageWithPage({
			labels: ["a"],
			record: ["out"],
			lifecycle: false,
		});
		const connection = new Connection();
		const a = connection.createDataChannel("a") as FakeDataChannel;
		const b = connection.createDataChannel("b") as FakeDataChannel;
		a.open();
		b.open();
		a.send("kept");
		a.receive("not recorded");
		b.send("not recorded");
		expect((await stage.webrtc.frames()).map((f) => f.payload.text())).toEqual([
			"kept",
		]);
		await stage.dispose();
	});

	it("leaves the page as it found it when the stage goes away", async () => {
		const { stage, page, Connection, PeerConnection } = await stageWithPage();
		const channel = new Connection().remoteChannel("telemetry");
		const appSaw: unknown[] = [];
		channel.addEventListener("message", (e) =>
			appSaw.push((e as MessageEvent).data),
		);
		channel.open();
		await stage.webrtc.suppress("telemetry");
		await stage.dispose();
		// A page that outlives the stage is not left suppressed, nor hooked.
		channel.receive("after the stage");
		expect(appSaw).toEqual(["after the stage"]);
		expect(page.scope["RTCPeerConnection"]).toBe(PeerConnection);
	});

	it("runs twice under two names, each recording its own labels", async () => {
		const stage = createStage({
			plugins: [
				webrtc({ labels: ["room/cursor"] }),
				named("telemetry", webrtc({ labels: ["room/presence"] })),
			],
		});
		const context = createFakeContext();
		await stage.attach(context);
		const { Connection } = webrtcFrame(context.newPage());
		const connection = new Connection();
		(connection.createDataChannel("room/cursor") as FakeDataChannel)
			.open()
			.send("command");
		connection.remoteChannel("room/presence").open().receive("state");
		expect(
			(await stage.webrtc.frames({ kind: "message" })).map((f) => f.endpoint),
		).toEqual(["room/cursor"]);
		expect(
			(await stage.telemetry.frames({ kind: "message" })).map((f) => [
				f.protocol,
				f.endpoint,
			]),
		).toEqual([["telemetry", "room/presence"]]);
		await stage.dispose();
	});
});
