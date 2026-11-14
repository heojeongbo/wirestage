/**
 * The frame types the plugin contract is written in terms of.
 *
 * FSD's cross-import notation: `entities/plugin` may import this file and
 * nothing else from `entities/frame`. It keeps the dependency between the two
 * entities explicit and one-way — the frame model knows nothing of plugins.
 */
export type { Frame, FrameFilter, Timeline } from "../model/frame.js";
