import { describe, expect, it } from "vitest";

import { checkBoundaries } from "../../scripts/boundaries.js";

/**
 * The checker is the only thing that keeps the architecture in docs/ true, so
 * it is tested like the code it guards: a tree that conforms, and one
 * violation at a time, each caught by the rule that names it.
 */
const conforming: Record<string, string> = {
	"index.ts": `
		export type { Frame } from "./entities/frame/index.js";
		export { toBuffer } from "./shared/lib/bytes/index.js";
		export { createStage } from "./widgets/stage/index.js";`,
	"playwright.ts": `export { withStage } from "./app/playwright/index.js";`,
	"rest.ts": `export * from "./features/rest/index.js";`,
	"connect.ts": `export * from "./features/connect/index.js";`,
	"shared/lib/bytes/index.ts": `export { toBuffer } from "./bytes.js";`,
	"shared/lib/bytes/bytes.ts": `export const toBuffer = () => Buffer.alloc(0);`,
	"shared/lib/logger/index.ts": `export { log } from "./logger.js";`,
	"shared/lib/logger/logger.ts": `
		import { createLogger } from "@heojeongbo/log-palette";
		export const log = createLogger("x");`,
	"shared/api/playwright/index.ts": `export type { ContextPort, CookieJarPort, PagePort } from "./ports.js";`,
	"shared/api/playwright/ports.ts": `
		export interface PagePort {}
		export interface CookieJarPort {}
		export interface ContextPort extends CookieJarPort {}`,
	"shared/api/server/index.ts": `export { listen } from "./listen.js";`,
	"shared/api/server/listen.ts": `
		import { createServer } from "http";
		import type { Server } from "node:net";
		import { toBuffer } from "../../lib/bytes/index.js";
		export const listen = (): Server => createServer(() => toBuffer());`,
	"entities/frame/index.ts": `export type { Frame } from "./model/frame.js";`,
	"entities/frame/model/frame.ts": `export interface Frame {}`,
	"entities/frame/@x/plugin.ts": `export type { Frame } from "../model/frame.js";`,
	"entities/plugin/index.ts": `export type { Plugin } from "./model/plugin.js";`,
	"entities/plugin/model/plugin.ts": `
		import type { PagePort } from "../../../shared/api/playwright/index.js";
		import type { Frame } from "../../frame/@x/plugin.js";
		export interface Plugin { frame: Frame; page: PagePort }`,
	"features/rest/index.ts": `export { rest } from "./lib/rest.js";`,
	"features/rest/model/types.ts": `
		import type { CookieJarPort } from "../../../shared/api/playwright/index.js";
		export interface Options { jar: import("../../../shared/api/playwright/index.js").CookieJarPort | CookieJarPort }`,
	"features/rest/lib/rest.ts": `
		import type { Plugin } from "../../../entities/plugin/index.js";
		import type { Options } from "../model/types.js";
		export const rest = (options: Options): Plugin | Options => options;`,
	// Not shipped, so not held to the rules.
	"features/rest/rest.test.ts": `
		import leftPad from "left-pad";
		import { chromium } from "playwright";
		import { internal } from "../../widgets/stage/lib/create-stage.js";`,
	"features/connect/index.ts": `export { connect } from "./lib/connect.js";`,
	"features/connect/lib/connect.ts": `
		import { gunzipSync } from "node:zlib";
		import { create } from "@bufbuild/protobuf";
		import { Code } from "@connectrpc/connect";
		import { codeFromString } from "@connectrpc/connect/protocol-connect";
		export const connect = () => [gunzipSync, create, Code, codeFromString];`,
	"widgets/stage/index.ts": `export { createStage } from "./lib/create-stage.js";`,
	"widgets/stage/model/stage.ts": `export interface Stage {}`,
	"widgets/stage/lib/create-stage.ts": `
		import type { ServerResponse } from "node:http";
		import type { Plugin } from "../../../entities/plugin/index.js";
		import type { ContextPort } from "../../../shared/api/playwright/index.js";
		import { listen } from "../../../shared/api/server/index.js";
		import type { Stage } from "../model/stage.js";
		export const createStage = (): Stage | Plugin | ContextPort | ServerResponse => listen();`,
	"app/playwright/index.ts": `export { withStage } from "./lib/fixture.js";`,
	"app/playwright/lib/fixture.ts": `
		import type { TestType } from "@playwright/test";
		import { createStage } from "../../../widgets/stage/index.js";
		export const withStage = (test: TestType<object, object>) => [test, createStage];`,
	"__fixtures__/fake-playwright.ts": `import { chromium } from "playwright";`,
};

const check = (changes: Record<string, string>) =>
	checkBoundaries(new Map(Object.entries({ ...conforming, ...changes })));

describe("architecture boundaries", () => {
	it("passes a tree that follows every rule", () => {
		expect(check({})).toEqual([]);
	});

	const up = "../../..";
	const violations: [name: string, file: string, text: string, rule: string][] =
		[
			[
				"an upward import",
				"shared/lib/bytes/bytes.ts",
				`import type { Frame } from "${up}/entities/frame/index.js";`,
				"upward dependency (rule 1)",
			],
			[
				"a feature importing another",
				"features/rest/lib/rest.ts",
				`import { connect } from "../../connect/index.js";`,
				"cross-slice import (rule 2)",
			],
			[
				"an @x file used outside the entities",
				"widgets/stage/lib/create-stage.ts",
				`import type { Frame } from "${up}/entities/frame/@x/plugin.js";`,
				"(rule 2)",
			],
			[
				"an @x file used by another entity than it names",
				"entities/plugin/model/plugin.ts",
				`import type { Frame } from "../../frame/@x/stage.js";`,
				"(rule 2)",
			],
			[
				"an @x file used by its own entity",
				"entities/frame/model/frame.ts",
				`import type { Frame } from "../@x/plugin.js";`,
				"(rule 2)",
			],
			[
				"an import past a unit's index",
				"widgets/stage/lib/create-stage.ts",
				`import type { Frame } from "${up}/entities/frame/model/frame.js";`,
				"bypasses the public API",
			],
			[
				"an index that is not the unit's",
				"widgets/stage/lib/create-stage.ts",
				`import type { Frame } from "${up}/entities/frame/model/index.js";`,
				"bypasses the public API",
			],
			[
				"a unit importing its own index",
				"features/rest/lib/rest.ts",
				`import { rest } from "../index.js";`,
				"its own index.js (rule 3)",
			],
			[
				"types that depend on code",
				"features/rest/model/types.ts",
				`import type { rest } from "../lib/rest.js";`,
				"model does not import lib (rule 4)",
			],
			[
				"the stage importing a protocol",
				"widgets/stage/lib/create-stage.ts",
				`import { rest } from "${up}/features/rest/index.js";`,
				"only a package entrypoint imports a feature (rule 5)",
			],
			[
				"a pure utility reaching for infrastructure",
				"shared/lib/bytes/bytes.ts",
				`import { listen } from "../../api/server/index.js";`,
				"shared/lib does not import shared/api (rule 6)",
			],
			[
				"the core entrypoint exporting a protocol",
				"index.ts",
				`export * from "./features/rest/index.js";`,
				"(rule 7)",
			],
			[
				"a protocol entrypoint exporting another",
				"rest.ts",
				`export * from "./features/connect/index.js";`,
				"(rule 7)",
			],
			[
				"an entrypoint importing a package",
				"rest.ts",
				`export { Code } from "@connectrpc/connect";`,
				"only re-exports public APIs (rule 7)",
			],
			[
				"an entrypoint importing past an index",
				"index.ts",
				`export { createStage } from "./widgets/stage/lib/create-stage.js";`,
				"an entrypoint imports a unit's index.js (rule 3)",
			],
			[
				"Playwright at runtime",
				"app/playwright/lib/fixture.ts",
				`import { test } from "@playwright/test";`,
				"only as types (rule 8)",
			],
			[
				// Emitted as `import {} from`: the module is still loaded.
				"a type import that still loads Playwright",
				"app/playwright/lib/fixture.ts",
				`import { type TestType } from "@playwright/test";`,
				"only as types (rule 8)",
			],
			[
				"Playwright named below the fixture",
				"widgets/stage/lib/create-stage.ts",
				`import type { Page } from "playwright-core";`,
				"only by app/playwright (rule 8)",
			],
			[
				"Connect outside its feature",
				"features/rest/lib/rest.ts",
				`import type { Code } from "@connectrpc/connect/protocol";`,
				"(rule 9)",
			],
			[
				"log-palette outside the logger",
				"widgets/stage/lib/create-stage.ts",
				`import { createLogger } from "@heojeongbo/log-palette";`,
				"(rule 10)",
			],
			[
				"a widget loading a Node module",
				"widgets/stage/lib/create-stage.ts",
				`import { createServer } from "node:http";`,
				"not load its modules (rule 11)",
			],
			[
				"Node types in the plugin contract",
				"entities/plugin/model/plugin.ts",
				`import type { IncomingMessage } from "http";`,
				"(rule 11)",
			],
			[
				"a Node module loaded on demand",
				"features/rest/lib/rest.ts",
				`export const load = () => import("node:fs/promises");`,
				"(rule 11)",
			],
			[
				"a package that is not a dependency",
				"shared/lib/bytes/bytes.ts",
				`import leftPad from "left-pad";`,
				"not a dependency of the library (rule 12)",
			],
			[
				"a plugin written against the browser context",
				"features/rest/lib/rest.ts",
				`import type { ContextPort } from "${up}/shared/api/playwright/index.js";`,
				"(rule 13)",
			],
			[
				"every port taken at once",
				"features/rest/lib/rest.ts",
				`import type * as ports from "${up}/shared/api/playwright/index.js";`,
				"(rule 13)",
			],
			[
				"the context named in a type expression",
				"features/rest/model/types.ts",
				`export type Context = import("${up}/shared/api/playwright/index.js").ContextPort;`,
				"(rule 13)",
			],
			[
				"a port imported as a value",
				"entities/plugin/model/plugin.ts",
				`import { PagePort } from "${up}/shared/api/playwright/index.js";`,
				"(rule 13)",
			],
			[
				"a file that is not TypeScript",
				"shared/lib/bytes/extra.js",
				`export const x = 1;`,
				"TypeScript only (rule S1)",
			],
			[
				// Read like any other module: one the checker skipped was a hole.
				"a rule broken in an .mts module",
				"features/rest/lib/unseen.mts",
				`import { chromium } from "playwright";`,
				"only by app/playwright (rule 8)",
			],
			[
				"a Node module loaded through getBuiltinModule",
				"features/rest/lib/rest.ts",
				`export const http = process.getBuiltinModule("node:http");`,
				"(rule 11)",
			],
			[
				"an entrypoint with code of its own",
				"rest.ts",
				`export * from "./features/rest/index.js";\nexport const version = 1;`,
				"export … from statements only (rule 7)",
			],
			[
				// The port would reach a feature under another unit's name.
				"a unit handing on another unit's API",
				"shared/api/server/index.ts",
				`export { listen } from "./listen.js";\nexport type { PagePort } from "../playwright/index.js";`,
				"re-exports only its own modules (rule 3)",
			],
			[
				"a computed specifier",
				"shared/api/server/listen.ts",
				`export const load = (name: string) => import(name);`,
				"a specifier is a string literal (rule 14)",
			],
			[
				"require",
				"shared/api/server/listen.ts",
				`export const fs = require("node:fs");`,
				"no require (rule 14)",
			],
			[
				"import = require",
				"shared/api/server/listen.ts",
				`import fs = require("node:fs");`,
				"no require (rule 14)",
			],
			[
				"shipped code importing a fake",
				"features/rest/lib/rest.ts",
				`import { fake } from "${up}/__fixtures__/fake-playwright.js";`,
				"may not import test code",
			],
			[
				"shipped code importing a test",
				"features/rest/lib/rest.ts",
				`import "../rest.test.js";`,
				"may not import test code",
			],
			[
				"an import that leaves src",
				"index.ts",
				`export * from "../scripts/boundaries.js";`,
				"leaves src",
			],
			[
				"a module of no unit",
				"widgets/stage/lib/create-stage.ts",
				`import { x } from "${up}/index.js";`,
				"not a module of a unit (rule S1)",
			],
			[
				"a file beside the slices",
				"features/helpers.ts",
				`export const x = 1;`,
				"not in a unit (rule S1)",
			],
			[
				"a shared module outside api and lib",
				"shared/util/text/index.ts",
				`export const x = 1;`,
				"not in a unit (rule S1)",
			],
			[
				"a second index in a unit",
				"entities/frame/model/index.ts",
				`export type { Frame } from "./frame.js";`,
				"one index.ts, at its root (rule S2)",
			],
			[
				"a unit without a public API",
				"shared/lib/id/id.ts",
				`export const x = 1;`,
				"shared/lib/id — has no index.ts (rule S2)",
			],
			[
				"a file beside a slice's segments",
				"features/rest/helpers.ts",
				`export const x = 1;`,
				"(rule S3)",
			],
			[
				"a folder that is not a segment",
				"features/rest/utils/helpers.ts",
				`export const x = 1;`,
				"(rule S3)",
			],
			[
				"@x outside the entities",
				"features/rest/@x/connect.ts",
				`export const x = 1;`,
				"(rule S3)",
			],
		];

	it.each(violations)("catches %s", (_name, file, text, rule) => {
		// The one violation, and nothing it did not cause.
		expect(check({ [file]: text })).toEqual([expect.stringContaining(rule)]);
	});

	it("reports every reference in a file, wherever it is written", () => {
		const errors = check({
			"features/rest/lib/rest.ts": `
				export { Code } from "@connectrpc/connect";
				export type Message = typeof import("@bufbuild/protobuf");
				export async function load() {
					if (Math.random() > 1) return (await import("node:fs")).readFileSync;
					return import("left-pad");
				}`,
		});
		expect(errors.map((error) => error.split(" — ")[1])).toEqual([
			"Connect and protobuf belong to features/connect (rule 9)",
			"Connect and protobuf belong to features/connect (rule 9)",
			"Node built-ins belong to shared/api and features/connect (rule 11)",
			"not a dependency of the library (rule 12)",
		]);
	});
});
