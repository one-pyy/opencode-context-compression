import assert from "node:assert/strict";
import test from "node:test";

import type { PluginInput } from "@opencode-ai/plugin";

test("built plugin entry exports a server function for host plugin loading", async () => {
  const entry = await import("../../../dist/index.js");

  assert.equal(typeof entry.default, "object");
  assert.equal(entry.default?.id, "opencode-context-compression");
  assert.equal(typeof entry.default?.server, "function");
  assert.equal(typeof entry.server, "function");
  assert.equal(entry.server, entry.default?.server);

  const hooks = await entry.default.server(createPluginInput());
  assert.equal(typeof hooks["chat.params"], "function");
  assert.equal(typeof hooks["experimental.chat.messages.transform"], "function");
  assert.equal(typeof hooks["tool.execute.before"], "function");
});

function createPluginInput(): PluginInput {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  return {
    client: {} as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: repoRoot,
    worktree: repoRoot,
    serverUrl: new URL("http://localhost:3900"),
    $: {} as PluginInput["$"],
  };
}
