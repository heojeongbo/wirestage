import type { WirePlugin } from "../model/plugin.js";

/**
 * Identity, for inference: it keeps the plugin's `name` a literal type, so
 * `createStage({ plugins: [myPlugin()] })` types `stage.myPlugin` without the
 * author writing the generic arguments out.
 */
export function definePlugin<const Name extends string, Api>(
	plugin: WirePlugin<Name, Api>,
): WirePlugin<Name, Api> {
	return plugin;
}
