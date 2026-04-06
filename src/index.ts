import type { Plugin } from "@opencode-ai/plugin";

/**
 * TODO(new-project): rewrite plugin wiring to match DESIGN.md.
 *
 * Direction:
 * - register the new DESIGN-driven compression_mark tool
 * - rebuild messages.transform around history-first replay, not DB-first marks
 * - keep chat.params as a narrow scheduler seam only
 * - rebuild send-entry gating around the new runtime model
 * - do not restore route-era or allowDelete compatibility behavior
 */
const plugin: Plugin = async () => {
  throw new Error(
    "TODO(new-project): src/index.ts was intentionally stripped. Rebuild the plugin entry from DESIGN.md instead of restoring the legacy wiring.",
  );
};

export default plugin;
