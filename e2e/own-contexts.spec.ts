import { withStage } from "@heojeongbo/wirestage/playwright";
import { json, rest } from "@heojeongbo/wirestage/rest";
import { test as base, expect } from "@playwright/test";

import { ORIGIN } from "./test.js";

// A suite whose tests open their own contexts -- two users at once -- and so
// has no use for the test's own `context`.
const test = withStage(base, {
	plugins: [rest({ baseURL: "/api" })],
	attach: false,
});

const APP = `<!doctype html>
<p id="who">loading</p>
<script>
	fetch("/api/whoami").then((r) => r.json()).then((me) => {
		document.querySelector("#who").textContent = me.name;
	});
</script>`;

test("a test that opens its own contexts attaches each one", async ({
	browser,
	stage,
}) => {
	const operator = await browser.newContext();
	const admin = await browser.newContext();
	try {
		for (const context of [operator, admin]) {
			await context.route(`${ORIGIN}/`, (route) =>
				route.fulfill({ status: 200, contentType: "text/html", body: APP }),
			);
			await stage.attach(context);
		}
		// One stub, both contexts.
		await stage.rest.get("/whoami", json({ name: "someone" }));
		const pages = [await operator.newPage(), await admin.newPage()];
		for (const page of pages) {
			await page.goto(`${ORIGIN}/`);
			await expect(page.locator("#who")).toHaveText("someone");
		}
		const calls = await stage.rest.calls({ path: "/whoami" });
		expect(new Set(calls.map((call) => call.request.context)).size).toBe(2);
	} finally {
		await operator.close();
		await admin.close();
	}
});
