import { abort, json } from "@heojeongbo/wirestage/rest";

import { EchoService } from "../src/__fixtures__/gen/wirestage/test/v1/echo_pb.js";
import { type AppWindow, expect, ORIGIN, test } from "./test.js";

test("a stubbed REST call reaches the page and lands on the timeline", async ({
	page,
	stage,
}) => {
	await stage.rest.get("/rooms/:id", (request) =>
		json({ name: request.params["id"], state: "idle" }),
	);
	await page.goto(`${ORIGIN}/`);
	await expect(page.locator("#room")).toHaveText("r1 is idle");
	const [call] = await stage.rest.calls({ path: "/rooms/:id" });
	expect(call?.status).toBe(200);
});

test("a network fault shows the app's offline state", async ({
	page,
	stage,
}) => {
	await stage.rest.get("/rooms/:id", abort("connectionrefused"));
	await page.goto(`${ORIGIN}/`);
	await expect(page.locator("#room")).toHaveText("offline");
	const faults = await stage.frames({ protocol: "rest", kind: "fault" });
	expect(faults).toHaveLength(1);
});

test("the test drives an event stream and a WebSocket", async ({
	page,
	stage,
}) => {
	await stage.rest.get("/rooms/:id", json({ name: "r1", state: "busy" }));
	const feed = await stage.sse.stream("/events");
	const socket = await stage.websocket.mock(`ws://localhost:4610/live`);
	await page.goto(`${ORIGIN}/`);
	const events = await feed.next();
	await events.send("tick-1");
	await events.send("tick-2");
	await expect(page.locator("#feed")).toHaveText("tick-1 tick-2");
	const connection = await socket.next();
	await expect(connection.nextMessage()).resolves.toMatchObject({
		data: "ready",
	});
	connection.send("hello page");
	await expect(page.locator("#socket")).toHaveText("hello page");
	// One timeline, every protocol, in the order things happened.
	await stage.mark("done");
	const protocols = new Set((await stage.frames()).map((f) => f.protocol));
	expect([...protocols].sort()).toEqual([
		"rest",
		"sse",
		"websocket",
		"wirestage",
	]);
});

test("a stubbed RPC answers the page in the protocol it called with", async ({
	page,
	stage,
}) => {
	const say = await stage.connect.unary(EchoService.method.say, (request) => ({
		text: `hello ${request.text}`,
	}));
	await page.goto(`${ORIGIN}/`);
	await page.evaluate(() => (window as unknown as AppWindow).say("page"));
	await expect(page.locator("#reply")).toHaveText("hello page");
	expect(say.requests.map((request) => request.text)).toEqual(["page"]);
	const [call] = await stage.connect.calls(EchoService.method.say);
	expect(call).toMatchObject({
		caller: "page",
		answeredBy: "stub",
		protocol: "connect",
		status: { code: 0 },
	});
});

test("a data channel is recorded, and goes quiet on demand", async ({
	page,
	stage,
}) => {
	await page.goto(`${ORIGIN}/`);
	await page.evaluate(() =>
		(window as unknown as AppWindow).openChannel("room/cursor"),
	);
	await stage.webrtc.waitForChannel("room/cursor");
	await page.evaluate(() =>
		(window as unknown as AppWindow).channel.send("forward"),
	);
	await expect(page.locator("#peer")).toHaveText("forward");
	const sent = await stage.webrtc.messages("room/cursor", {
		direction: "out",
	});
	expect(sent.map((frame) => frame.payload.text())).toEqual(["forward"]);

	// The link stays up and loses what is sent: the case no server can make.
	const restore = await stage.webrtc.suppress("room/cursor", {
		direction: "out",
	});
	await page.evaluate(() =>
		(window as unknown as AppWindow).channel.send("lost"),
	);
	await restore();
	await page.evaluate(() =>
		(window as unknown as AppWindow).channel.send("stop"),
	);
	await expect(page.locator("#peer")).toHaveText("stop");
	const faults = await stage.webrtc.frames({ kind: "fault" });
	expect(faults.map((frame) => frame.payload.text())).toEqual(["lost"]);
});
