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
  assert.ok(promptFiles.includes("prompts/reminder-soft.md"));
  assert.ok(promptFiles.includes("prompts/reminder-hard.md"));
  assert.equal(runtimeConfig.repoRoot, resolveRuntimeConfigRepoRoot());
  assert.match(runtimeConfig.configPath, /src\/config\/runtime-config\.jsonc$/u);
  assert.match(runtimeConfig.promptPath, /prompts\/compaction\.md$/u);
  assert.deepEqual(runtimeConfig.models, [
    "openai.right/gpt-5.4-mini",
    "openai.doro/gpt-5.4-mini",
  ]);
  assert.equal(runtimeConfig.markedTokenAutoCompactionThreshold, 20_000);
  assert.equal(runtimeConfig.smallUserMessageThreshold, 1_024);
  assert.equal(runtimeConfig.reminder.hsoft, 30_000);
  assert.equal(runtimeConfig.reminder.hhard, 70_000);
  assert.equal(runtimeConfig.reminder.counter.source, "eligible_messages");
  assert.equal(runtimeConfig.reminder.counter.soft.repeatEvery, 3);
  assert.equal(runtimeConfig.reminder.counter.hard.repeatEvery, 1);
  assert.match(
    runtimeConfig.reminder.prompts.softPath,
    /prompts\/reminder-soft\.md$/u,
  );
  assert.match(
    runtimeConfig.reminder.prompts.hardPath,
    /prompts\/reminder-hard\.md$/u,
  );
  assert.match(runtimeConfig.reminder.prompts.softText, /consider compacting/u);
  assert.match(
    runtimeConfig.reminder.prompts.hardText,
    /compact older compressible context now/u,
  );
  assert.equal(runtimeConfig.logging.level, "off");
  assert.equal(runtimeConfig.compressing.timeoutSeconds, 600);
  assert.equal(runtimeConfig.compressing.timeoutMs, 600_000);
  assert.equal(runtimeConfig.schedulerMarkThreshold, 1);
  assert.equal(runtimeConfig.route, "keep");
  assert.match(runtimeConfig.runtimeLogPath, /logs\/runtime-events\.jsonl$/u);
  assert.match(runtimeConfig.seamLogPath, /logs\/seam-observation\.jsonl$/u);
  assert.equal(runtimeConfig.debugSnapshotPath, undefined);
  assert.match(runtimeConfig.promptText, /route=keep/u);
  assert.match(await readRepoFile("src/config/runtime-config.jsonc"), /"\$schema"\s*:\s*"\.\/runtime-config\.schema\.json"/u);
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
    const softReminderFromConfig = join(
      tempDirectory,
      "prompts",
      "soft-reminder.md",
    );
    const hardReminderFromConfig = join(
      tempDirectory,
      "prompts",
      "hard-reminder.md",
    );
    const runtimeConfigPath = join(tempDirectory, "runtime-config.json");

    await mkdir(join(tempDirectory, "prompts"), { recursive: true });
    await writeFile(promptFromConfig, "Config prompt text.\n", "utf8");
    await writeFile(promptFromEnv, "Env prompt text.\n", "utf8");
    await writeFile(
      softReminderFromConfig,
      [
        "Soft reminder from config.",
        "{{compressible_content}}",
        "{{compaction_target}}",
        "{{preserved_fields}}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      hardReminderFromConfig,
      [
        "Hard reminder from config.",
        "{{compressible_content}}",
        "{{compaction_target}}",
        "{{preserved_fields}}",
        "",
      ].join("\n"),
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
            promptPaths: {
              soft: softReminderFromConfig,
              hard: hardReminderFromConfig,
            },
            counter: {
              source: "assistant_turns",
              soft: { repeatEvery: 4 },
              hard: { repeatEvery: 2 },
            },
          },
          logging: {
            level: "error",
          },
          compressing: {
            timeoutSeconds: 45,
          },
          route: "keep",
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
      [RUNTIME_CONFIG_ENV.route]: "delete",
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
    assert.equal(runtimeConfig.reminder.counter.source, "assistant_turns");
    assert.equal(runtimeConfig.reminder.counter.soft.repeatEvery, 4);
    assert.equal(runtimeConfig.reminder.counter.hard.repeatEvery, 2);
    assert.equal(
      runtimeConfig.reminder.prompts.softPath,
      softReminderFromConfig,
    );
    assert.equal(
      runtimeConfig.reminder.prompts.hardPath,
      hardReminderFromConfig,
    );
    assert.equal(runtimeConfig.logging.level, "debug");
    assert.equal(runtimeConfig.compressing.timeoutSeconds, 90);
    assert.equal(runtimeConfig.compressing.timeoutMs, 90_000);
    assert.equal(runtimeConfig.route, "delete");
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
    await writeFile(
      runtimeConfigPath,
      JSON.stringify(
        {
          version: 1,
          promptPath: "prompts/missing.md",
          compactionModels: ["config-primary"],
          reminder: {
            promptPaths: {
              soft: "prompts/missing-soft.md",
              hard: "prompts/missing-hard.md",
            },
          },
          route: "keep",
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
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
