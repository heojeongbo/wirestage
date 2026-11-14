/**
 * Compiled by `pnpm type:check`, never run: the plugin APIs must be inferred
 * from the plugin list with no annotations, and misuse must not compile.
 */
import type { BrowserContext } from "@playwright/test";

import { connect } from "../../src/connect.js";
import {
	createStage,
	definePlugin,
	named,
	type Stage,
} from "../../src/index.js";
import { rest } from "../../src/rest.js";
import { webrtc } from "../../src/webrtc.js";

declare const context: BrowserContext;

const stage = createStage({ plugins: [webrtc(), rest(), connect()] });

// Each API is mounted under its plugin's literal name.
export const suppress: (label: string) => Promise<() => Promise<void>> =
	stage.webrtc.suppress;
export const get = stage.rest.get;
export const unary = stage.connect.unary;
export const attached: Promise<() => Promise<void>> = stage.attach(context);

// A plugin that is not on the list has no API.
// @ts-expect-error: no sse plugin was given
export const missing = stage.sse;

// A third-party plugin gets the same inference.
const counter = definePlugin({
	name: "counter",
	setup: () => ({ api: { value: 0 } }),
});
const custom = createStage({ plugins: [counter] });
export const value: number = custom.counter.value;

// One plugin twice, under names of its own: two backends, two APIs.
const two = createStage({
	plugins: [named("billing", rest()), named("search", rest())],
});
export const billing = two.billing.get;
export const search = two.search.get;
// @ts-expect-error: renamed, so nothing is mounted under the plugin's own name
export const unnamed = two.rest;

// A plugin built on another gets that plugin's API, typed.
const graphql = definePlugin({
	name: "graphql",
	setup: (context) => {
		const http = context.use(rest({ baseURL: "/graphql" }));
		return { api: { query: http.post } };
	},
});
export const query = createStage({ plugins: [graphql] }).graphql.query;

// A marker takes options; meta goes inside them.
export const marked = stage.mark("checkpoint", { meta: { step: 1 } });
// @ts-expect-error: meta is no longer the second argument itself
export const bare = stage.mark("checkpoint", { step: 1 });
export const cursor: Promise<readonly unknown[]> = stage
	.cursor({ page: "p1" })
	.take();

// A served fake has the page's route API.
export const served = stage.rest
	.serve({ name: "fake backend" })
	.then((server) => server.get("/x/:id", { kind: "passthrough" }));

// A stage type can be named for helpers that take one.
export function helper(
	s: Stage<readonly [ReturnType<typeof webrtc>]>,
): Promise<unknown> {
	return s.webrtc.frames();
}
