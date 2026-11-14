import type { Attachment } from "../../../entities/plugin/index.js";
import type { ContextPort } from "../../../shared/api/playwright/index.js";

/**
 * An attachment as the stage's engines see it: with the browser context that
 * plugins are not given.
 */
export interface AttachedContext extends Attachment {
	readonly context: ContextPort;
}
