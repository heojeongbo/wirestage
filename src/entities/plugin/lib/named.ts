import type { WirePlugin } from "../model/plugin.js";

/**
 * The same plugin under another name: mounted as `stage.<name>`, and
 * recording its frames under that name. What lets one protocol run twice —
 * two backends, two sets of channels — with each instance's traffic apart:
 *
 *     plugins: [rest({ baseURL: "/api" }), named("billing", rest({ baseURL: "https://billing.test" }))]
 */
export function named<const Name extends string, Api>(
	name: Name,
	plugin: WirePlugin<string, Api>,
): WirePlugin<Name, Api> {
	return {
		name,
		scope: plugin.scope,
		// Called on the plugin, not copied off it: a plugin written as a class
		// has `setup` on its prototype, which a spread leaves behind.
		setup: (context) => plugin.setup(context),
	};
}
