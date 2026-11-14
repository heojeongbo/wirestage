/**
 * Compiled by `pnpm type:check`, never run.
 *
 * The ports in src/shared/api/playwright are structural copies of Playwright's
 * types. If a Playwright release changes a signature the library depends on,
 * this file stops compiling — before any user's `stage.attach(context)` does.
 */
import type {
	BrowserContext,
	Page,
	Request,
	Route,
	WebSocketRoute,
} from "@playwright/test";

import type {
	ContextPort,
	CookieJarPort,
	FramePort,
	PagePort,
	RequestPort,
	RoutePort,
	WebSocketRoutePort,
} from "../../src/shared/api/playwright/index.js";

declare const browserContext: BrowserContext;
declare const page: Page;
declare const request: Request;
declare const route: Route;
declare const webSocketRoute: WebSocketRoute;

export const contextPort: ContextPort = browserContext;
// What a drive client is given as a session: a context is a cookie jar.
export const cookieJarPort: CookieJarPort = browserContext;
export const pagePort: PagePort = page;
export const framePort: FramePort = page.mainFrame();
export const requestPort: RequestPort = request;
export const routePort: RoutePort = route;
export const webSocketRoutePort: WebSocketRoutePort = webSocketRoute;
