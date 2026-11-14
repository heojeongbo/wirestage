/**
 * The suite's own `test`: Playwright's, extended with a stage carrying every
 * protocol. A project would put the same three lines in its fixtures file.
 *
 * Everything here imports the package by name, which resolves through its
 * `exports` to `dist/`: the suite runs what is published, built by tsc, in
 * the runner users run it in. `pnpm e2e` builds first.
 */

import { connect } from "@heojeongbo/wirestage/connect";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { rest } from "@heojeongbo/wirestage/rest";
import { sse } from "@heojeongbo/wirestage/sse";
import { webrtc } from "@heojeongbo/wirestage/webrtc";
import { websocket } from "@heojeongbo/wirestage/websocket";
import { test as base } from "@playwright/test";

export const ORIGIN = "http://localhost:4610";

export const test = withStage(base, {
	plugins: [
		rest({ baseURL: "/api" }),
		connect({ baseURL: "/api" }),
		sse(),
		websocket(),
		webrtc(),
	],
}).extend({
	// Serve the app under test from memory: an origin with one HTML page.
	page: async ({ page, context }, use) => {
		await context.route(`${ORIGIN}/`, (route) =>
			route.fulfill({ status: 200, contentType: "text/html", body: APP }),
		);
		await use(page);
	},
});

export { expect } from "@playwright/test";

/** A tiny app: a status line fed by a REST call, an SSE feed and a socket. */
const APP = `<!doctype html>
<title>app</title>
<p id="room">loading</p>
<p id="feed"></p>
<p id="socket"></p>
<p id="reply"></p>
<p id="peer"></p>
<script>
	fetch("/api/rooms/r1").then((r) => r.json()).then((room) => {
		document.querySelector("#room").textContent = room.name + " is " + room.state;
	}, () => {
		document.querySelector("#room").textContent = "offline";
	});
	new EventSource("/events").onmessage = (event) => {
		document.querySelector("#feed").textContent += event.data + " ";
	};
	const socket = new WebSocket("ws://localhost:4610/live");
	socket.onmessage = (event) => {
		document.querySelector("#socket").textContent = event.data;
	};
	socket.onopen = () => socket.send("ready");

	// A Connect unary call, as connect-web sends it with JSON.
	window.say = async (text) => {
		const response = await fetch("/api/wirestage.test.v1.EchoService/Say", {
			method: "POST",
			headers: { "content-type": "application/json", "connect-protocol-version": "1" },
			body: JSON.stringify({ text }),
		});
		document.querySelector("#reply").textContent = (await response.json()).text;
	};
	// Two peers in one page, joined by a data channel.
	window.openChannel = async (label) => {
		const a = new RTCPeerConnection();
		const b = new RTCPeerConnection();
		a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
		b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
		b.ondatachannel = (e) => {
			e.channel.onmessage = (m) => {
				document.querySelector("#peer").textContent = m.data;
			};
		};
		const channel = a.createDataChannel(label);
		await a.setLocalDescription(await a.createOffer());
		await b.setRemoteDescription(a.localDescription);
		await b.setLocalDescription(await b.createAnswer());
		await a.setRemoteDescription(b.localDescription);
		await new Promise((resolve) => (channel.onopen = resolve));
		window.channel = channel;
	};
</script>`;

/** What the app above puts on \`window\` for the tests to call. */
export interface AppWindow {
	say(text: string): Promise<void>;
	openChannel(label: string): Promise<void>;
	channel: RTCDataChannel;
}
