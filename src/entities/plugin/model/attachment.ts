import type { CookieJarPort } from "../../../shared/api/playwright/index.js";

/**
 * One browser context the stage is attached to, as a plugin sees it. The
 * context itself stays with the stage: a plugin reaches the browser through
 * the services of its `PluginContext`, never through the context.
 */
export interface Attachment {
	/** `c1`, `c2`, ... — what frames name in their `context` field. */
	readonly id: string;
	/** The context's base URL, when the caller supplied one. */
	readonly baseURL: string | undefined;
	/** The context's cookie jar, for a client that calls as the signed-in page. */
	readonly cookies: CookieJarPort;
}
