# Getting started

## Install

```sh
pnpm add -D @heojeongbo/wirestage
# only for /connect:
pnpm add -D @connectrpc/connect @connectrpc/connect-node @bufbuild/protobuf
```

## Give your tests a stage

Put the plugins your app's wire protocols need into your fixtures file, once:

```ts
import { test as base } from "@playwright/test";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { rest } from "@heojeongbo/wirestage/rest";
import { sse } from "@heojeongbo/wirestage/sse";
import { websocket } from "@heojeongbo/wirestage/websocket";

export const test = withStage(base, {
	plugins: [rest({ baseURL: "/api" }), sse(), websocket()],
	// Attach the timeline to the report: "on-failure" (default), "always", "never".
	report: "on-failure",
});
export { expect } from "@playwright/test";
```

Each test gets its own stage, attached to the test's `context` before the test
body runs and disposed after it. `WIRESTAGE_REPORT` and `WIRESTAGE_LOG`
override the `report` and `log` options from the environment; a value they
cannot use is ignored with one warning.

A report holds the newest 1,000 frames (`reportLimit`), and says how many
earlier ones it left out.

Tests that open their own contexts — two users at once, a context per role —
pass `attach: false` and attach each context they open. The fixture then never
asks Playwright for `context`, so no unused one is created:

```ts
import { test as base, expect } from "@playwright/test";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { json, rest } from "@heojeongbo/wirestage/rest";

const test = withStage(base, { plugins: [rest()], attach: false });

test("both users see the stub", async ({ browser, stage }) => {
	const operator = await browser.newContext();
	const admin = await browser.newContext();
	await stage.attach(operator);
	await stage.attach(admin);
	await stage.rest.get("/api/whoami", json({ name: "someone" }));
	const page = await admin.newPage();
	await page.goto("/");
	await expect(page.getByText("someone")).toBeVisible();
});
```

## Fake, record, fault

```ts
import { test as base, expect } from "@playwright/test";
import { withStage } from "@heojeongbo/wirestage/playwright";
import { abort, delay, json, rest } from "@heojeongbo/wirestage/rest";

const test = withStage(base, { plugins: [rest({ baseURL: "/api" })] });

test("retries after a dropped request", async ({ page, stage }) => {
	// Newest route wins: the first request is dropped, the next one answered.
	await stage.rest.get("/status", json({ ok: true }));
	await stage.rest.get("/status", abort("connectionreset"), { times: 1 });
	await page.goto("/");
	await expect(page.getByText("online")).toBeVisible();
	const calls = await stage.rest.calls({ path: "/status" });
	expect(calls.map((call) => call.status)).toEqual([undefined, 200]);
});

test("shows a spinner while the answer is slow", async ({ page, stage }) => {
	await stage.rest.get("/status", delay(2_000, json({ ok: true })));
	await page.goto("/");
	await expect(page.getByRole("progressbar")).toBeVisible();
});
```

## Contexts you create yourself

A suite that makes its own contexts (`browser.newContext({ storageState })`)
attaches a stage to each one. Attach before the first `goto`: page hooks are
init scripts, and an init script only runs in documents created after it.

```ts
import type { Browser } from "@playwright/test";
import { createStage } from "@heojeongbo/wirestage";
import { webrtc } from "@heojeongbo/wirestage/webrtc";

export async function signedInPage(browser: Browser, storageState: string) {
	const context = await browser.newContext({ storageState });
	const stage = createStage({ plugins: [webrtc()] });
	await stage.attach(context);
	const page = await context.newPage();
	// Closing the context detaches the stage; dispose() also stops its servers.
	return { page, stage, close: async () => (await stage.dispose(), await context.close()) };
}
```

One stage can attach to several contexts; their frames share one timeline and
carry `context: "c1"`, `"c2"`, ... so a test can tell them apart. An attach
that fails is undone, so it can be tried again.

## Two backends, one protocol

A plugin's API is mounted under its name, and its frames carry that name as
their `protocol`. `named()` gives an instance a name of its own, so one stage
can hold the same protocol twice:

```ts
import { createStage, named } from "@heojeongbo/wirestage";
import { json, rest } from "@heojeongbo/wirestage/rest";

const stage = createStage({
	plugins: [
		named("billing", rest({ baseURL: "https://billing.example.test" })),
		named("search", rest({ baseURL: "/search/v2" })),
	],
});

export async function stubs() {
	await stage.billing.get("/invoices/:id", json({ paid: true }));
	await stage.search.get("/query", json({ hits: [] }));
	// Each instance's traffic, apart.
	return stage.frames({ protocol: "billing" });
}
```

## Next

- [The timeline](timeline.md): reading what happened.
- The protocol you need: [Connect](protocols/connect.md),
  [REST](protocols/rest.md), [SSE](protocols/sse.md),
  [WebSocket](protocols/websocket.md), [WebRTC](protocols/webrtc.md).
