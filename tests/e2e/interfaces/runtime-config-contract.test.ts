import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OpencodeContextCompressionRuntimeConfigError,
  RUNTIME_CONFIG_ENV,
  loadRuntimeConfig,
  readCompactionThresholds,
  readReminderThresholds,
  resolveRuntimeConfigRepoRoot,
} from "../../../src/config/runtime-config.js";

test("loader uses repo-owned defaults and resolves schema-aligned assets", () => {
  const runtimeConfig = loadRuntimeConfig({});

  assert.equal(runtimeConfig.repoRoot, resolveRuntimeConfigRepoRoot());
  assert.match(runtimeConfig.configPath, /src\/config\/runtime-config\.jsonc$/u);
  assert.match(runtimeConfig.promptPath, /prompts\/compaction\.md$/u);
  assert.match(runtimeConfig.promptText, /Context compression output contract/u);
  assert.deepEqual(runtimeConfig.models, [
    "openai.right/gpt-5.4-mini",
    "openai.doro/gpt-5.4-mini",
  ]);
  assert.deepEqual(readCompactionThresholds(runtimeConfig), {
    markedTokenAutoCompactionThreshold: 20_000,
    schedulerMarkThreshold: 1,
    smallUserMessageThreshold: 1_024,
  });
  assert.deepEqual(readReminderThresholds(runtimeConfig), {
    hsoft: 30_000,
    hhard: 70_000,
    softRepeatEveryTokens: 20_000,
    hardRepeatEveryTokens: 10_000,
  });
  assert.equal(runtimeConfig.logging.level, "off");
  assert.equal(runtimeConfig.compressing.timeoutSeconds, 600);
  assert.equal(runtimeConfig.compressing.timeoutMs, 600_000);
  assert.match(
    runtimeConfig.reminder.prompts.compactOnly.soft.path,
    /prompts\/reminder-soft-compact-only\.md$/u,
  );
  assert.match(
    runtimeConfig.reminder.prompts.deleteAllowed.hard.path,
    /prompts\/reminder-hard-delete-allowed\.md$/u,
  );
});

test("field env overrides win over config file values", async () => {
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-runtime-config-"),
  );

  try {
    await mkdir(join(tempDirectory, "prompts"), { recursive: true });

    const configPromptPath = join(tempDirectory, "prompts", "from-config.md");
    const envPromptPath = join(tempDirectory, "prompts", "from-env.md");
    const configPath = join(tempDirectory, "runtime-config.json");

    await writeFile(configPromptPath, "Config prompt text.\n", "utf8");
    await writeFile(envPromptPath, "Env prompt text.\n", "utf8");
    await writeReminderAssets(tempDirectory);
    await writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          promptPath: configPromptPath,
          compactionModels: ["config-primary", "config-fallback"],
          markedTokenAutoCompactionThreshold: 12_345,
          smallUserMessageThreshold: 222,
          reminder: {
            hsoft: 5,
            hhard: 8,
            softRepeatEveryTokens: 4,
            hardRepeatEveryTokens: 2,
            promptPaths: {
              compactOnly: {
                soft: join(tempDirectory, "prompts", "soft-compact.md"),
                hard: join(tempDirectory, "prompts", "hard-compact.md"),
              },
              deleteAllowed: {
                soft: join(tempDirectory, "prompts", "soft-delete.md"),
                hard: join(tempDirectory, "prompts", "hard-delete.md"),
              },
            },
          },
          logging: {
            level: "error",
          },
          compressing: {
            timeoutSeconds: 45,
          },
          runtimeLogPath: "logs/from-config-runtime.jsonl",
          seamLogPath: "logs/from-config-seam.jsonl",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const runtimeConfig = loadRuntimeConfig({
      [RUNTIME_CONFIG_ENV.configPath]: configPath,
      [RUNTIME_CONFIG_ENV.promptPath]: envPromptPath,
      [RUNTIME_CONFIG_ENV.models]: "env-primary, env-fallback",
      [RUNTIME_CONFIG_ENV.runtimeLogPath]: "logs/from-env-runtime.jsonl",
      [RUNTIME_CONFIG_ENV.seamLogPath]: "logs/from-env-seam.jsonl",
      [RUNTIME_CONFIG_ENV.logLevel]: "debug",
      [RUNTIME_CONFIG_ENV.compressingTimeoutSeconds]: "90",
      [RUNTIME_CONFIG_ENV.debugSnapshotPath]: "logs/from-env-debug.json",
    });

    assert.equal(runtimeConfig.configPath, configPath);
    assert.equal(runtimeConfig.promptPath, envPromptPath);
    assert.equal(runtimeConfig.promptText, "Env prompt text.\n");
    assert.deepEqual(runtimeConfig.models, ["env-primary", "env-fallback"]);
    assert.equal(runtimeConfig.markedTokenAutoCompactionThreshold, 12_345);
    assert.equal(runtimeConfig.smallUserMessageThreshold, 222);
    assert.equal(runtimeConfig.reminder.hsoft, 5);
    assert.equal(runtimeConfig.reminder.hhard, 8);
    assert.equal(runtimeConfig.reminder.softRepeatEveryTokens, 4);
    assert.equal(runtimeConfig.reminder.hardRepeatEveryTokens, 2);
    assert.equal(runtimeConfig.logging.level, "debug");
    assert.equal(runtimeConfig.compressing.timeoutSeconds, 90);
    assert.equal(runtimeConfig.compressing.timeoutMs, 90_000);
    assert.equal(
      runtimeConfig.runtimeLogPath,
      join(resolveRuntimeConfigRepoRoot(), "logs", "from-env-runtime.jsonl"),
    );
    assert.equal(
      runtimeConfig.seamLogPath,
      join(resolveRuntimeConfigRepoRoot(), "logs", "from-env-seam.jsonl"),
    );
    assert.equal(
      runtimeConfig.debugSnapshotPath,
      join(resolveRuntimeConfigRepoRoot(), "logs", "from-env-debug.json"),
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("invalid config, blank env values, and legacy fields fail fast", async () => {
  assert.throws(
    () =>
      loadRuntimeConfig({
        [RUNTIME_CONFIG_ENV.promptPath]: "   ",
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
      assert.match(String(error), /PROMPT_PATH is set but empty/u);
      return true;
    },
  );

  assert.throws(
    () =>
      loadRuntimeConfig({
        [RUNTIME_CONFIG_ENV.logLevel]: "warn",
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
      assert.match(String(error), /must be one of: off, error, info, debug/u);
      return true;
    },
  );

  assert.throws(
    () =>
      loadRuntimeConfig({
        [RUNTIME_CONFIG_ENV.compressingTimeoutSeconds]: "0",
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
      assert.match(String(error), /must be a positive integer/u);
      return true;
    },
  );

  const tempDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-runtime-config-invalid-"),
  );

  try {
    await mkdir(join(tempDirectory, "prompts"), { recursive: true });
    await writeFile(join(tempDirectory, "prompts", "compaction.md"), "Compaction prompt.\n", "utf8");
    await writeReminderAssets(tempDirectory);

    const configPath = join(tempDirectory, "runtime-config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          promptPath: join(tempDirectory, "prompts", "compaction.md"),
          compactionModels: ["config-primary"],
          reminder: {
            hsoft: 5,
            hhard: 8,
            softRepeatEveryTokens: 4,
            hardRepeatEveryTokens: 2,
            counter: {
              source: "messages",
            },
            promptPaths: {
              compactOnly: {
                soft: join(tempDirectory, "prompts", "soft-compact.md"),
                hard: join(tempDirectory, "prompts", "hard-compact.md"),
              },
              deleteAllowed: {
                soft: join(tempDirectory, "prompts", "soft-delete.md"),
                hard: join(tempDirectory, "prompts", "hard-delete.md"),
              },
            },
          },
          runtimeLogPath: "logs/runtime.jsonl",
          seamLogPath: "logs/seam.jsonl",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    assert.throws(
      () =>
        loadRuntimeConfig({
          [RUNTIME_CONFIG_ENV.configPath]: configPath,
        }),
      (error: unknown) => {
        assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
        assert.match(String(error), /unsupported property 'counter'/u);
        return true;
      },
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

async function writeReminderAssets(tempDirectory: string): Promise<void> {
  await writeFile(
    join(tempDirectory, "prompts", "soft-compact.md"),
    "Soft compact-only reminder.\n",
    "utf8",
  );
  await writeFile(
    join(tempDirectory, "prompts", "hard-compact.md"),
    "Hard compact-only reminder.\n",
    "utf8",
  );
  await writeFile(
    join(tempDirectory, "prompts", "soft-delete.md"),
    "Soft delete-allowed reminder.\n",
    "utf8",
  );
  await writeFile(
    join(tempDirectory, "prompts", "hard-delete.md"),
    "Hard delete-allowed reminder.\n",
    "utf8",
  );
}
