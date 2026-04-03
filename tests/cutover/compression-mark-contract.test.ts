import assert from "node:assert/strict";
import test from "node:test";

import { readInstalledPluginTypes, withLoadedPluginHooks } from "./cutover-test-helpers.js";

test("plugin entrypoint exposes repo-local compression_mark through Hooks.tool", async () => {
  const installedPluginTypes = await readInstalledPluginTypes();
  assert.match(
    installedPluginTypes,
    /tool\?:\s*\{\s*\[key: string\]: ToolDefinition;/u,
    "expected installed @opencode-ai/plugin types to expose Hooks.tool before auditing the cutover contract",
  );

  await withLoadedPluginHooks(async ({ hooks }) => {
    const hookKeys = Object.keys(hooks).sort();
    const toolRegistry = (hooks as { tool?: Record<string, unknown> }).tool;
    const toolKeys = toolRegistry && typeof toolRegistry === "object" ? Object.keys(toolRegistry).sort() : [];

    if (!toolRegistry || typeof toolRegistry !== "object" || !("compression_mark" in toolRegistry)) {
      assert.fail(
        [
          "Cutover gap: plugin entrypoint must expose a repo-local public `compression_mark` tool via `Hooks.tool`.",
          "The installed @opencode-ai/plugin type surface already supports `Hooks.tool`, so this is a missing plugin contract rather than an upstream API limitation.",
          `Current hook keys from src/index.ts: ${hookKeys.join(", ") || "(none)"}.`,
          `Current tool keys: ${toolKeys.join(", ") || "(missing Hooks.tool registry)"}.`,
        ].join("\n"),
      );
    }
  });
});
