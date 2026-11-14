/**
 * Install the packed tarball into an empty project, the way a user would,
 * and prove the public surface from the outside:
 *  - the optional peers (Connect, protobuf) are NOT pulled in;
 *  - every entrypoint except /connect type-checks under strict settings
 *    without them, declarations included (skipLibCheck off), with only
 *    `@types/node` beside it as in any Playwright project;
 *  - the core runs: a stage attaches to a context and records a marker;
 *  - a CommonJS project can `require()` it, which is how Playwright loads
 *    the tests of a project without `"type": "module"`;
 *  - with the peers installed, /connect type-checks and runs too.
 * devDependencies cannot mask a stray import here, which is the point.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { devDependencies } = JSON.parse(readFileSync("package.json", "utf8"));

const directory = mkdtempSync(join(tmpdir(), "wirestage-consumer-"));

/** Type-checks and emits one file of the consumer, declarations included. */
const compile = (file) =>
	execFileSync(
		process.execPath,
		[
			resolve("node_modules/typescript/bin/tsc"),
			"--strict",
			"--skipLibCheck",
			"false",
			"--module",
			"NodeNext",
			"--moduleResolution",
			"NodeNext",
			"--target",
			"ES2022",
			"--lib",
			"ES2023,DOM",
			"--types",
			"node",
			file,
		],
		{ cwd: directory, stdio: "inherit" },
	);

try {
	const [packed] = JSON.parse(
		execFileSync(
			"npm",
			["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
			{
				encoding: "utf8",
			},
		),
	);
	const unexpected = packed.files
		.map((file) => file.path)
		.filter(
			(path) =>
				path.includes(".test.") ||
				path.includes("__fixtures__") ||
				path.startsWith("tests/"),
		);
	assert.deepEqual(unexpected, [], "tests and fixtures must not ship");
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ private: true, type: "module" }),
	);
	execFileSync(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			join(directory, packed.filename),
			`@types/node@${devDependencies["@types/node"]}`,
		],
		{ cwd: directory, stdio: "pipe" },
	);
	for (const name of [
		"@connectrpc/connect",
		"@connectrpc/connect-node",
		"@bufbuild/protobuf",
	])
		assert.equal(
			existsSync(join(directory, "node_modules", name)),
			false,
			`${name} must stay optional`,
		);
	assert.equal(
		existsSync(join(directory, "node_modules", "@playwright", "test")),
		true,
		"@playwright/test is the one required peer",
	);
	writeFileSync(
		join(directory, "consumer.ts"),
		`
import { type ContextPort, createStage, type Stage } from "@heojeongbo/wirestage";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { json, rest } from "@heojeongbo/wirestage/rest";
import { sse } from "@heojeongbo/wirestage/sse";
import { webrtc } from "@heojeongbo/wirestage/webrtc";
import { websocket } from "@heojeongbo/wirestage/websocket";

const stage: Stage<readonly [ReturnType<typeof rest>, ReturnType<typeof webrtc>]> = createStage({
	plugins: [rest(), webrtc()],
});
void [withStage, json, sse, websocket];
// A real BrowserContext fits ContextPort as-is; with no browser here, the
// smallest object that does.
const context: ContextPort = {
	route: async () => undefined,
	unroute: async () => undefined,
	routeWebSocket: async () => undefined,
	addInitScript: async () => undefined,
	exposeBinding: async () => undefined,
	pages: () => [],
	cookies: async () => [],
	addCookies: async () => undefined,
	on: () => undefined,
	off: () => undefined,
};
await stage.attach(context);
const marker = await stage.mark("installed");
if (marker.endpoint !== "installed") throw new Error("marker missing");
await stage.dispose();
`,
	);
	compile("consumer.ts");
	execFileSync(process.execPath, ["consumer.js"], {
		cwd: directory,
		stdio: "inherit",
	});

	writeFileSync(
		join(directory, "consumer.cjs"),
		`
const { createStage } = require("@heojeongbo/wirestage");
const { withStage } = require("@heojeongbo/wirestage/playwright");
const { rest } = require("@heojeongbo/wirestage/rest");
const stage = createStage({ plugins: [rest()] });
if (typeof stage.rest.get !== "function" || typeof withStage !== "function")
	throw new Error("the package did not load through require()");
`,
	);
	execFileSync(process.execPath, ["consumer.cjs"], {
		cwd: directory,
		stdio: "inherit",
	});

	execFileSync(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			...[
				"@connectrpc/connect",
				"@connectrpc/connect-node",
				"@bufbuild/protobuf",
			].map((name) => `${name}@${devDependencies[name]}`),
		],
		{ cwd: directory, stdio: "pipe" },
	);
	writeFileSync(
		join(directory, "consumer-connect.ts"),
		`
import { Code, ConnectError } from "@connectrpc/connect";
import { createStage } from "@heojeongbo/wirestage";
import { connect, createRpcClient, statusOf } from "@heojeongbo/wirestage/connect";

const stage = createStage({ plugins: [connect({ baseURL: "/api" })] });
void createRpcClient;
// The consumer's ConnectError is the library's: one copy of the peer, or
// \`instanceof\` inside the library would not know it.
const refused = await statusOf(
	Promise.reject(new ConnectError("not yours", Code.PermissionDenied)),
);
if (refused !== Code.PermissionDenied) throw new Error("two copies of Connect");
if (typeof stage.connect.unary !== "function") throw new Error("connect missing");
await stage.dispose();
`,
	);
	compile("consumer-connect.ts");
	execFileSync(process.execPath, ["consumer-connect.js"], {
		cwd: directory,
		stdio: "inherit",
	});
	console.log(
		`Packed consumer passed: ${packed.files.length} files, strict declarations without the optional peers, a working stage from import and from require, and /connect with its peers.`,
	);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
