/**
 * Budgeted performance measurement: `pnpm perf` writes perf-results.json,
 * `pnpm perf:check` also fails when a budget is exceeded.
 *
 * A budget is about five times the median on the reference machine
 * (docs/performance.md): room for a slower CI runner, none for a regression
 * of an order of magnitude.
 *
 * Two kinds of numbers:
 *  - Node hot paths, per operation: what every recorded frame costs.
 *  - Real Chromium scenarios: what an instrumented page costs the app — the
 *    WebRTC send hook, a stubbed unary round trip, live-stream latency.
 *
 * `--skip-browser` measures only the Node paths (machines without Chromium).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";

import { create, toBinary } from "@bufbuild/protobuf";
import { chromium } from "@playwright/test";

import {
	EchoRequestSchema,
	EchoService,
} from "../src/__fixtures__/gen/wirestage/test/v1/echo_pb.js";
import { connect } from "../src/connect.js";
import { compileFilter } from "../src/entities/frame/index.js";
import { decodeResponseBody } from "../src/features/connect/lib/protocol.js";
import {
	compileUrlMatcher,
	createManualClock,
	createStage,
	createTimeline,
	decodeEnvelopes,
	EnvelopeFlag,
	encodeEnvelope,
	encodeEnvelopes,
} from "../src/index.js";
import { webrtc } from "../src/webrtc.js";

const CHECK = process.argv.includes("--check");
const SKIP_BROWSER = process.argv.includes("--skip-browser");

interface Result {
	readonly scenario: string;
	readonly unit: "ns/op" | "us/op" | "ms";
	readonly median: number;
	readonly p95: number;
	readonly budget?: number;
}
const results: Result[] = [];

/** 1,000 warm-up runs, then 9 samples of `perSample` runs; ns per run. */
function measure(
	scenario: string,
	perSample: number,
	action: () => void,
	budgetNs?: number,
): void {
	for (let i = 0; i < 1000; i++) action();
	const samples: number[] = [];
	for (let sample = 0; sample < 9; sample++) {
		const start = performance.now();
		for (let i = 0; i < perSample; i++) action();
		samples.push(((performance.now() - start) * 1e6) / perSample);
	}
	samples.sort((a, b) => a - b);
	results.push({
		scenario,
		unit: "ns/op",
		median: samples[4] as number,
		p95: samples[8] as number,
		...(budgetNs === undefined ? {} : { budget: budgetNs }),
	});
}

function percentiles(values: number[]): { median: number; p95: number } {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) =>
		sorted[
			Math.min(sorted.length - 1, Math.floor(q * sorted.length))
		] as number;
	return { median: at(0.5), p95: at(0.95) };
}

// ---------------------------------------------------------------- Node paths
const clock = createManualClock();
const payload = new Uint8Array(64);
{
	const timeline = createTimeline({ clock, capacity: 50_000 });
	measure(
		"timeline: append a 64 B frame at capacity",
		10_000,
		() => {
			timeline.append({
				protocol: "webrtc",
				kind: "message",
				direction: "out",
				endpoint: "room/cursor",
				source: "page",
				data: payload,
			});
		},
		4_500,
	);
}
{
	const timeline = createTimeline({ clock, capacity: 20_000 });
	for (let i = 0; i < 10_000; i++)
		timeline.append({
			protocol: i % 3 === 0 ? "webrtc" : "connect",
			kind: "message",
			direction: i % 2 === 0 ? "out" : "in",
			endpoint: i % 5 === 0 ? "room/cursor" : "pkg.Svc/Watch",
			source: "page",
		});
	const match = compileFilter({ protocol: "webrtc", endpoint: "room/cursor" });
	measure(
		"timeline: query 10,000 frames",
		100,
		() => {
			timeline.frames().filter(match);
		},
		500_000,
	);
}
{
	const body = encodeEnvelopes(
		Array.from({ length: 100 }, () => ({ flags: 0, data: payload })),
	);
	measure(
		"envelope: decode a 100-message body",
		1_000,
		() => {
			decodeEnvelopes(body);
		},
		35_000,
	);
	const grpcWeb = new Uint8Array([
		...body,
		...encodeEnvelope(
			EnvelopeFlag.trailer,
			new TextEncoder().encode("grpc-status: 0\r\n"),
		),
	]);
	measure(
		"connect: decode a 100-message gRPC-web response",
		1_000,
		() => {
			decodeResponseBody(
				{ protocol: "grpc-web", binary: true, base64: false, enveloped: true },
				{ status: 200, headers: {}, body: grpcWeb },
			);
		},
		40_000,
	);
}
{
	const match = compileUrlMatcher("**/api/v1/rooms/*/state");
	const url = new URL("http://localhost:3000/api/v1/rooms/r1/state");
	measure(
		"match: a glob against a full URL",
		10_000,
		() => {
			match(url);
		},
		250,
	);
}

// ------------------------------------------------------------ Chromium paths
const ORIGIN = "http://localhost:4710";
const LOOPBACK = `<!doctype html><script>
	window.open2 = async () => {
		const a = new RTCPeerConnection(), b = new RTCPeerConnection();
		a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
		b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
		const channel = a.createDataChannel("room/cursor");
		await a.setLocalDescription(await a.createOffer());
		await b.setRemoteDescription(a.localDescription);
		await b.setLocalDescription(await b.createAnswer());
		await a.setRemoteDescription(b.localDescription);
		await new Promise((r) => (channel.onopen = r));
		window.channel = channel;
	};
	window.sendMany = (n) => {
		const buffer = new Uint8Array(64).buffer;
		const start = performance.now();
		for (let i = 0; i < n; i++) window.channel.send(buffer);
		return ((performance.now() - start) * 1000) / n;
	};
</script>`;

async function browserScenarios(): Promise<void> {
	const browser = await chromium.launch({
		args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
	});
	try {
		const serve = async (instrumented: boolean) => {
			const context = await browser.newContext();
			await context.route(`${ORIGIN}/`, (route) =>
				route.fulfill({
					status: 200,
					contentType: "text/html",
					body: LOOPBACK,
				}),
			);
			const stage = createStage({
				plugins: [webrtc(), connect({ baseURL: "/api" })],
			});
			if (instrumented) await stage.attach(context);
			const page = await context.newPage();
			await page.goto(`${ORIGIN}/`);
			return { context, page, stage };
		};

		// WebRTC: what the send hook costs a page that sends 60 frames a second.
		const sendCost = async (instrumented: boolean): Promise<number[]> => {
			const { context, page, stage } = await serve(instrumented);
			await page.evaluate(() =>
				(window as unknown as { open2(): Promise<void> }).open2(),
			);
			const samples: number[] = [];
			for (let i = 0; i < 9; i++)
				samples.push(
					await page.evaluate(() =>
						(window as unknown as { sendMany(n: number): number }).sendMany(
							500,
						),
					),
				);
			await stage.dispose();
			await context.close();
			return samples;
		};
		const plain = percentiles(await sendCost(false));
		const hooked = percentiles(await sendCost(true));
		results.push({
			scenario: "webrtc: send-hook overhead per 64 B send",
			unit: "us/op",
			median: Math.max(0, hooked.median - plain.median),
			p95: Math.max(0, hooked.p95 - plain.p95),
			budget: 12,
		});

		// Flush: 5,000 recorded sends, from page buffer to timeline.
		{
			const { context, page, stage } = await serve(true);
			await page.evaluate(() =>
				(window as unknown as { open2(): Promise<void> }).open2(),
			);
			await page.evaluate(() =>
				(window as unknown as { sendMany(n: number): number }).sendMany(5_000),
			);
			const start = performance.now();
			const frames = await stage.webrtc.messages("room/cursor", {
				direction: "out",
			});
			const ms = performance.now() - start;
			assert.equal(frames.length, 5_000, "every send must reach the timeline");
			results.push({
				scenario: "webrtc: flush 5,000 recorded sends",
				unit: "ms",
				median: ms,
				p95: ms,
				budget: 1_500,
			});
			await stage.dispose();
			await context.close();
		}

		// A stubbed gRPC-web unary call, page to stub and back.
		{
			const { context, page, stage } = await serve(true);
			await stage.connect.unary(EchoService.method.say, { text: "ok" });
			const body = [
				...encodeEnvelope(
					0,
					toBinary(EchoRequestSchema, create(EchoRequestSchema, { text: "x" })),
				),
			];
			const timings = await page.evaluate(async (bytes) => {
				const out: number[] = [];
				for (let i = 0; i < 200; i++) {
					const start = performance.now();
					const response = await fetch(
						"/api/wirestage.test.v1.EchoService/Say",
						{
							method: "POST",
							headers: {
								"content-type": "application/grpc-web+proto",
								"x-grpc-web": "1",
							},
							body: new Uint8Array(bytes),
						},
					);
					await response.arrayBuffer();
					out.push(performance.now() - start);
				}
				return out;
			}, body);
			results.push({
				scenario: "connect: stubbed gRPC-web unary round trip",
				unit: "ms",
				...percentiles(timings.slice(20)),
				budget: 10,
			});
			await stage.dispose();
			await context.close();
		}

		// Live stream: the test sends, the page receives.
		{
			const { context, page, stage } = await serve(true);
			const stub = await stage.connect.stream(EchoService.method.watch);
			const body = [
				...encodeEnvelope(
					0,
					toBinary(EchoRequestSchema, create(EchoRequestSchema)),
				),
			];
			await page.evaluate((bytes) => {
				const arrivals: number[] = [];
				(window as unknown as { arrivals: number[] }).arrivals = arrivals;
				void (async () => {
					const response = await fetch(
						"/api/wirestage.test.v1.EchoService/Watch",
						{
							method: "POST",
							headers: {
								"content-type": "application/grpc-web+proto",
								"x-grpc-web": "1",
							},
							body: new Uint8Array(bytes),
						},
					);
					const reader = (
						response.body as ReadableStream<Uint8Array>
					).getReader();
					let pending = new Uint8Array(0);
					for (;;) {
						const { value, done } = await reader.read();
						if (done) return;
						const joined = new Uint8Array(pending.length + value.length);
						joined.set(pending);
						joined.set(value, pending.length);
						let offset = 0;
						while (joined.length - offset >= 5) {
							const length = new DataView(
								joined.buffer,
								offset + 1,
								4,
							).getUint32(0);
							if (joined.length - offset - 5 < length) break;
							if ((joined[offset] as number) === 0)
								arrivals.push(performance.timeOrigin + performance.now());
							offset += 5 + length;
						}
						pending = joined.subarray(offset);
					}
				})();
			}, body);
			const call = await stub.next({ timeout: 10_000 });
			const sentAt: number[] = [];
			for (let i = 0; i < 100; i++) {
				sentAt.push(performance.timeOrigin + performance.now());
				await call.send({ text: "m", index: BigInt(i) });
				await new Promise((r) => setTimeout(r, 2));
			}
			await page.waitForFunction(
				() =>
					(window as unknown as { arrivals: number[] }).arrivals.length >= 100,
				undefined,
				{ timeout: 10_000 },
			);
			const arrivals = await page.evaluate(
				() => (window as unknown as { arrivals: number[] }).arrivals,
			);
			const latencies = arrivals.map((at, i) => at - (sentAt[i] as number));
			results.push({
				scenario: "connect: live stream, test send to page receive",
				unit: "ms",
				...percentiles(latencies),
				budget: 5,
			});
			await call.end();
			await stage.dispose();
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

if (!SKIP_BROWSER) await browserScenarios();

// ------------------------------------------------------------- package size
let gzipBytes: number | undefined;
if (existsSync("dist")) {
	const js = readdirSync("dist", { recursive: true, encoding: "utf8" }).filter(
		(p) => p.endsWith(".js"),
	);
	gzipBytes = gzipSync(
		Buffer.concat(js.map((p) => readFileSync(`dist/${p}`))),
	).byteLength;
}
const GZIP_BUDGET = 64 * 1024;

writeFileSync(
	"perf-results.json",
	`${JSON.stringify(
		{
			environment: {
				node: process.version,
				platform: platform(),
				release: release(),
				cpu: cpus()[0]?.model,
			},
			methodology:
				"Node paths: 1,000 warm-up runs, then 9 samples; median and p95 of the per-sample mean. Chromium paths: per-call timings measured in the page.",
			gzipBytes,
			results,
		},
		null,
		2,
	)}\n`,
);
console.table(
	results.map((r) => ({
		...r,
		median: Number(r.median.toFixed(3)),
		p95: Number(r.p95.toFixed(3)),
	})),
);
console.log(
	gzipBytes === undefined
		? "dist/ not built: package size not measured."
		: `Runtime gzip: ${gzipBytes} bytes (budget ${GZIP_BUDGET}).`,
);

if (CHECK) {
	const over = results.filter(
		(r) => r.budget !== undefined && r.median > r.budget,
	);
	assert.deepEqual(
		over.map(
			(r) => `${r.scenario}: ${r.median.toFixed(2)} ${r.unit} > ${r.budget}`,
		),
		[],
		"performance budgets exceeded",
	);
	if (gzipBytes !== undefined)
		assert.ok(
			gzipBytes <= GZIP_BUDGET,
			`runtime gzip budget exceeded: ${gzipBytes}`,
		);
	console.log("Performance budgets passed.");
}
