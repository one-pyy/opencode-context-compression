import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolve, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadRuntimeConfig } from "../../src/config/runtime-config.js";

test("Config Precedence - Env overrides JSONC", async () => {
  // Create a temporary JSONC config
  const tempDir = join(tmpdir(), `opencode-config-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  const configPath = join(tempDir, "runtime-config.jsonc");
  
  const promptPathAbs = join(tempDir, "prompts/compaction.md");
  
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    allowDelete: false,
    promptPath: promptPathAbs,
    compactionModels: ["model-from-json"],
    runtimeLogPath: "logs/runtime.jsonl",
    seamLogPath: "logs/seam.jsonl"
  }));

  // Create a dummy prompt file
  mkdirSync(join(tempDir, "prompts"), { recursive: true });
  writeFileSync(join(tempDir, "prompts/compaction.md"), "Template Content");
  
  // Set up Env
  const env = {
    OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH: configPath,
    OPENCODE_CONTEXT_COMPRESSION_MODELS: "model-from-env",
    OPENCODE_CONTEXT_COMPRESSION_ALLOW_DELETE: "true",
  };

  const config = await loadRuntimeConfig(env);

  assert.deepEqual(config.models, ["model-from-env"], "Env should override compactionModels");
  assert.equal(config.configPath, resolve(configPath), "Env should set configPath");
  assert.equal(config.allowDelete, true, "Env should override allowDelete");
  assert.equal(config.promptText, "Template Content", "Should load dummy prompt text");
});

