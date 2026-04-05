import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OpencodeContextCompressionRuntimeConfigError,
  RUNTIME_CONFIG_ENV,
  loadRuntimeConfig,
  resolveRuntimeConfigRepoRoot,
} from "../../src/config/runtime-config.js";
import {
  listRepoFiles,
  listVisibleRepoFiles,
  readRepoFile,
} from "./cutover-test-helpers.js";

test("repo-owned runtime config, prompt assets, and docs resolve from this repo without legacy config ownership", async () => {
  const configFiles = listVisibleRepoFiles(await listRepoFiles("src/config"));
  const promptFiles = listVisibleRepoFiles(await listRepoFiles("prompts"));
  const readme = await readRepoFile("README.md");
  const readmeZh = await readRepoFile("readme.zh.md");
  const runtimeConfig = loadRuntimeConfig({});

  assert.ok(configFiles.includes("src/config/runtime-config.jsonc"));
  assert.ok(configFiles.includes("src/config/runtime-config.schema.json"));
  assert.ok(configFiles.includes("src/config/runtime-config.ts"));
  assert.ok(promptFiles.includes("prompts/compaction.md"));
  assert.ok(promptFiles.includes("prompts/reminder-soft-compact-only.md"));
  assert.ok(promptFiles.includes("prompts/reminder-soft-delete-allowed.md"));
  assert.ok(promptFiles.includes("prompts/reminder-hard-compact-only.md"));
  assert.ok(promptFiles.includes("prompts/reminder-hard-delete-allowed.md"));
  assert.ok(!promptFiles.includes("prompts/reminder-soft.md"));
  assert.ok(!promptFiles.includes("prompts/reminder-hard.md"));
  assert.equal(runtimeConfig.repoRoot, resolveRuntimeConfigRepoRoot());
  assert.match(
    runtimeConfig.configPath,
    /src\/config\/runtime-config\.jsonc$/u,
  );
  assert.match(runtimeConfig.promptPath, /prompts\/compaction\.md$/u);
  assert.deepEqual(runtimeConfig.models, [
    "openai.right/gpt-5.4-mini",
    "openai.doro/gpt-5.4-mini",
  ]);
  assert.equal(runtimeConfig.markedTokenAutoCompactionThreshold, 20_000);
  assert.equal(runtimeConfig.smallUserMessageThreshold, 1_024);
  assert.equal(runtimeConfig.reminder.hsoft, 30_000);
  assert.equal(runtimeConfig.reminder.hhard, 70_000);
  assert.equal(runtimeConfig.reminder.softRepeatEveryTokens, 20_000);
  assert.equal(runtimeConfig.reminder.hardRepeatEveryTokens, 10_000);
  assert.match(
    runtimeConfig.reminder.prompts.compactOnly.soft.path,
    /prompts\/reminder-soft-compact-only\.md$/u,
  );
  assert.match(
    runtimeConfig.reminder.prompts.deleteAllowed.hard.path,
    /prompts\/reminder-hard-delete-allowed\.md$/u,
  );
  assert.match(runtimeConfig.reminder.prompts.compactOnly.soft.text, /Compress material/u);
  assert.match(
    runtimeConfig.reminder.prompts.deleteAllowed.hard.text,
    /delete-style cleanup directly/u,
  );
  assert.equal(runtimeConfig.logging.level, "off");
  assert.equal(runtimeConfig.compressing.timeoutSeconds, 600);
  assert.equal(runtimeConfig.compressing.timeoutMs, 600_000);
  assert.equal(runtimeConfig.schedulerMarkThreshold, 1);
  assert.match(runtimeConfig.runtimeLogPath, /logs\/runtime-events\.jsonl$/u);
  assert.match(runtimeConfig.seamLogPath, /logs\/seam-observation\.jsonl$/u);
  assert.equal(runtimeConfig.debugSnapshotPath, undefined);
  assert.match(
    runtimeConfig.promptText,
    /Context compression output contract/u,
  );
  assert.match(
    await readRepoFile("src/config/runtime-config.jsonc"),
    /"\$schema"\s*:\s*"\.\/runtime-config\.schema\.json"/u,
  );
  assert.doesNotMatch(
    await readRepoFile("src/config/runtime-config.jsonc"),
    /counter\.source|repeatEvery"\s*:/u,
  );
  assert.doesNotMatch(readme, /config\/dcp-runtime\.json/u);
  assert.doesNotMatch(readmeZh, /config\/dcp-runtime\.json/u);
});

test("explicit env overrides take precedence over the repo-owned runtime config file", async () => {
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-runtime-config-"),
  );

  try {
    const promptFromConfig = join(tempDirectory, "prompts", "from-config.md");
    const promptFromEnv = join(tempDirectory, "prompts", "from-env.md");
    const softReminderCompactOnlyFromConfig = join(
      tempDirectory,
      "prompts",
      "soft-reminder-compact-only.md",
    );
    const hardReminderCompactOnlyFromConfig = join(
      tempDirectory,
      "prompts",
      "hard-reminder-compact-only.md",
    );
    const softReminderDeleteAllowedFromConfig = join(
      tempDirectory,
      "prompts",
      "soft-reminder-delete-allowed.md",
    );
    const hardReminderDeleteAllowedFromConfig = join(
      tempDirectory,
      "prompts",
      "hard-reminder-delete-allowed.md",
    );
    const runtimeConfigPath = join(tempDirectory, "runtime-config.json");

    await mkdir(join(tempDirectory, "prompts"), { recursive: true });
    await writeFile(promptFromConfig, "Config prompt text.\n", "utf8");
    await writeFile(promptFromEnv, "Env prompt text.\n", "utf8");
    await writeFile(
      softReminderCompactOnlyFromConfig,
      "Soft compact-only reminder from config.\n",
      "utf8",
    );
    await writeFile(
      hardReminderCompactOnlyFromConfig,
      "Hard compact-only reminder from config.\n",
      "utf8",
    );
    await writeFile(
      softReminderDeleteAllowedFromConfig,
      "Soft delete-allowed reminder from config.\n",
      "utf8",
    );
    await writeFile(
      hardReminderDeleteAllowedFromConfig,
      "Hard delete-allowed reminder from config.\n",
      "utf8",
    );
    await writeFile(
      runtimeConfigPath,
      JSON.stringify(
        {
          version: 1,
          promptPath: promptFromConfig,
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
                soft: softReminderCompactOnlyFromConfig,
                hard: hardReminderCompactOnlyFromConfig,
              },
              deleteAllowed: {
                soft: softReminderDeleteAllowedFromConfig,
                hard: hardReminderDeleteAllowedFromConfig,
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
      [RUNTIME_CONFIG_ENV.configPath]: runtimeConfigPath,
      [RUNTIME_CONFIG_ENV.promptPath]: promptFromEnv,
      [RUNTIME_CONFIG_ENV.models]: "env-primary, env-fallback",
      [RUNTIME_CONFIG_ENV.runtimeLogPath]: "logs/from-env-runtime.jsonl",
      [RUNTIME_CONFIG_ENV.seamLogPath]: "logs/from-env-seam.jsonl",
      [RUNTIME_CONFIG_ENV.logLevel]: "debug",
      [RUNTIME_CONFIG_ENV.compressingTimeoutSeconds]: "90",
      [RUNTIME_CONFIG_ENV.debugSnapshotPath]: "logs/from-env-debug.json",
    });

    assert.equal(runtimeConfig.configPath, runtimeConfigPath);
    assert.equal(runtimeConfig.promptPath, promptFromEnv);
    assert.equal(runtimeConfig.promptText, "Env prompt text.\n");
    assert.deepEqual(runtimeConfig.models, ["env-primary", "env-fallback"]);
    assert.equal(runtimeConfig.markedTokenAutoCompactionThreshold, 12_345);
    assert.equal(runtimeConfig.smallUserMessageThreshold, 222);
    assert.equal(runtimeConfig.reminder.hsoft, 5);
    assert.equal(runtimeConfig.reminder.hhard, 8);
    assert.equal(runtimeConfig.reminder.softRepeatEveryTokens, 4);
    assert.equal(runtimeConfig.reminder.hardRepeatEveryTokens, 2);
    assert.equal(
      runtimeConfig.reminder.prompts.compactOnly.soft.path,
      softReminderCompactOnlyFromConfig,
    );
    assert.equal(
      runtimeConfig.reminder.prompts.deleteAllowed.hard.path,
      hardReminderDeleteAllowedFromConfig,
    );
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

test("empty env overrides and missing repo-owned assets fail fast with plugin-owned errors", async () => {
  assert.throws(
    () =>
      loadRuntimeConfig({
        [RUNTIME_CONFIG_ENV.promptPath]: "   ",
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
      assert.match(
        String(error),
        /OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH is set but empty/u,
      );
      return true;
    },
  );

  assert.throws(
    () =>
      loadRuntimeConfig({
        [RUNTIME_CONFIG_ENV.configPath]: join(
          resolveRuntimeConfigRepoRoot(),
          "src",
          "config",
          "missing.json",
        ),
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
      assert.match(String(error), /Missing runtime config file/u);
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
      assert.match(
        String(error),
        /OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL field 'OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL' must be one of/u,
      );
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
      assert.match(
        String(error),
        /OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS must be a positive integer/u,
      );
      return true;
    },
  );

  const tempDirectory = await mkdtemp(
    join(
      tmpdir(),
      "opencode-context-compression-runtime-config-missing-prompt-",
    ),
  );

  try {
    const runtimeConfigPath = join(tempDirectory, "runtime-config.json");
    const missingCompactionPromptPath = join(
      tempDirectory,
      "prompts",
      "missing.md",
    );
    const missingSoftCompactPromptPath = join(
      tempDirectory,
      "prompts",
      "missing-soft.md",
    );
    const missingHardCompactPromptPath = join(
      tempDirectory,
      "prompts",
      "missing-hard.md",
    );
    const missingSoftDeletePromptPath = join(
      tempDirectory,
      "prompts",
      "missing-soft-delete.md",
    );
    const missingHardDeletePromptPath = join(
      tempDirectory,
      "prompts",
      "missing-hard-delete.md",
    );
    await mkdir(join(tempDirectory, "prompts"), { recursive: true });
    await writeFile(
      runtimeConfigPath,
      JSON.stringify(
        {
          version: 1,
          promptPath: missingCompactionPromptPath,
          compactionModels: ["config-primary"],
          reminder: {
            promptPaths: {
              compactOnly: {
                soft: missingSoftCompactPromptPath,
                hard: missingHardCompactPromptPath,
              },
              deleteAllowed: {
                soft: missingSoftDeletePromptPath,
                hard: missingHardDeletePromptPath,
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
          [RUNTIME_CONFIG_ENV.configPath]: runtimeConfigPath,
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof OpencodeContextCompressionRuntimeConfigError,
        );
        assert.match(String(error), /Missing prompt asset/u);
        return true;
      },
    );

    await writeFile(missingCompactionPromptPath, "Compaction prompt.\n", "utf8");
    await writeFile(
      missingSoftCompactPromptPath,
      "{{legacy_placeholder}}\n",
      "utf8",
    );
    await writeFile(
      missingHardCompactPromptPath,
      "Hard compact-only reminder.\n",
      "utf8",
    );
    await writeFile(
      missingSoftDeletePromptPath,
      "Soft delete-allowed reminder.\n",
      "utf8",
    );
    await writeFile(
      missingHardDeletePromptPath,
      "Hard delete-allowed reminder.\n",
      "utf8",
    );

    assert.throws(
      () =>
        loadRuntimeConfig({
          [RUNTIME_CONFIG_ENV.configPath]: runtimeConfigPath,
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof OpencodeContextCompressionRuntimeConfigError,
        );
        assert.match(
          String(error),
          /Reminder prompt asset .* must be plain text and must not contain template placeholders/u,
        );
        return true;
      },
    );

    await writeFile(
      missingSoftCompactPromptPath,
      "Soft compact-only reminder.\n",
      "utf8",
    );
    await writeFile(missingHardDeletePromptPath, "   \n", "utf8");

    assert.throws(
      () =>
        loadRuntimeConfig({
          [RUNTIME_CONFIG_ENV.configPath]: runtimeConfigPath,
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof OpencodeContextCompressionRuntimeConfigError,
        );
        assert.match(String(error), /must contain non-empty prompt text/u);
        return true;
      },
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("legacy reminder cadence fields and unsupported config properties are rejected", async () => {
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-runtime-config-legacy-fields-"),
  );

  try {
    await mkdir(join(tempDirectory, "prompts"), { recursive: true });
    await writeFile(join(tempDirectory, "prompts", "compaction.md"), "Compaction prompt.\n", "utf8");
    await writeFile(join(tempDirectory, "prompts", "soft-compact.md"), "Soft compact-only reminder.\n", "utf8");
    await writeFile(join(tempDirectory, "prompts", "hard-compact.md"), "Hard compact-only reminder.\n", "utf8");
    await writeFile(join(tempDirectory, "prompts", "soft-delete.md"), "Soft delete-allowed reminder.\n", "utf8");
    await writeFile(join(tempDirectory, "prompts", "hard-delete.md"), "Hard delete-allowed reminder.\n", "utf8");

    const runtimeConfigPath = join(tempDirectory, "runtime-config.json");
    await writeFile(
      runtimeConfigPath,
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
          [RUNTIME_CONFIG_ENV.configPath]: runtimeConfigPath,
        }),
      (error: unknown) => {
        assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
        assert.match(
          String(error),
          /field 'reminder' contains unsupported property 'counter'/u,
        );
        return true;
      },
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
