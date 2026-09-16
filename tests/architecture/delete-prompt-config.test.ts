import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRuntimeConfig, RUNTIME_CONFIG_ENV, resolveRuntimeConfigRepoRoot } from "../../src/config/runtime-config.js";
import { createPromptResolver } from "../../src/runtime/prompt-resolver.js";

test("delete prompt defaults to its own asset and missing manual config fails without compact fallback", async () => {
  const config = await loadRuntimeConfig({
    [RUNTIME_CONFIG_ENV.configPath]: join(resolveRuntimeConfigRepoRoot(), "src/config/runtime-config.jsonc"),
  });
  assert.match(config.deletePromptPath!, /prompts\/delete\.md$/);
  const resolver = createPromptResolver(config);
  assert.equal(await resolver.resolveCompactionPrompt(), config.promptText);
  assert.equal(await resolver.resolveCompactionPrompt("delete"), config.deletePromptText);
  assert.notEqual(config.deletePromptText, config.promptText);
  await assert.rejects(createPromptResolver({ ...config, deletePromptText: undefined }).resolveCompactionPrompt("delete"), /Missing delete prompt/);
});

test("delete prompt config supports env override and rejects missing, empty or unexpanded assets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "delete-prompt-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const promptPath = join(dir, "delete.md");
  const overridePath = join(dir, "override.md");
  await writeFile(configPath, JSON.stringify({
    version: 1, promptPath: "prompts/compaction.md", deletePromptPath: promptPath,
    compactionModels: ["provider/model"], runtimeLogPath: "logs/runtime.jsonl", seamLogPath: "logs/seam.jsonl",
  }));
  const env = { [RUNTIME_CONFIG_ENV.configPath]: configPath };
  await assert.rejects(loadRuntimeConfig(env), /Missing prompt asset/);
  await writeFile(promptPath, " \n");
  await assert.rejects(loadRuntimeConfig(env), /non-empty prompt text/);
  await writeFile(promptPath, "{{unresolved}}");
  await assert.rejects(loadRuntimeConfig(env), /must not contain template placeholders/);
  await writeFile(promptPath, "configured delete rules");
  await writeFile(overridePath, "override delete rules");
  assert.equal((await loadRuntimeConfig(env)).deletePromptText, "configured delete rules");
  assert.equal((await loadRuntimeConfig({ ...env, [RUNTIME_CONFIG_ENV.deletePromptPath]: overridePath })).deletePromptText, "override delete rules");
  await assert.rejects(loadRuntimeConfig({ ...env, [RUNTIME_CONFIG_ENV.deletePromptPath]: " " }), /set but empty/);
});
