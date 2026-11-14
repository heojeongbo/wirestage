import { defineConfig, devices } from "@playwright/test";

/**
 * The e2e suite runs the `withStage` fixture inside the real Playwright Test
 * runner — the one thing the vitest projects cannot do — and doubles as the
 * worked examples the docs link to.
 */
export default defineConfig({
	testDir: "e2e",
	fullyParallel: true,
	forbidOnly: Boolean(process.env["CI"]),
	reporter: process.env["CI"]
		? [["list"], ["html", { open: "never" }]]
		: "list",
	use: {
		trace: "retain-on-failure",
		launchOptions: {
			// Local ICE candidates as plain IPs, so two peers in one page connect.
			args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
		},
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
