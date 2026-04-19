import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OpencodeContextCompressionRuntimeConfigError,
  RUNTIME_CONFIG_ENV,
  loadRuntimeConfig,
  resolvePromptAsset,
  resolveReminderPrompt,
  resolveRuntimePathFromRepoRoot,
  resolveRuntimeConfigRepoRoot,
} from "../../../src/config/runtime-config.js";

test("prompt resolution selects reminder variants by severity and allowDelete", async () => {
  const runtimeConfig = await loadRuntimeConfig({});

  const softCompactOnly = resolveReminderPrompt(runtimeConfig, {
    severity: "soft",
    allowDelete: false,
  });
  const hardDeleteAllowed = resolveReminderPrompt(runtimeConfig, {
    severity: "hard",
    allowDelete: true,
  });

  assert.match(softCompactOnly.path, /reminder-soft-compact-only\.md$/u);
  assert.match(softCompactOnly.text, /Compress material/u);
  assert.match(hardDeleteAllowed.path, /reminder-hard-delete-allowed\.md$/u);
  assert.match(hardDeleteAllowed.text, /delete-style cleanup directly/u);
  assert.match(runtimeConfig.leadingUserPromptPath, /projection-leading-user\.md$/u);
  assert.match(runtimeConfig.leadingUserPromptText, /Do not invent, rewrite, or autocomplete/u);
});

test("repo-relative paths resolve from repo root and absolute paths stay absolute", () => {
  const repoRoot = resolveRuntimeConfigRepoRoot();

  assert.equal(
    resolveRuntimePathFromRepoRoot("prompts/compaction.md", {
      repoRoot,
      fieldPath: "promptPath",
    }),
    join(repoRoot, "prompts", "compaction.md"),
  );

  const absolutePath = join(repoRoot, "logs", "runtime-events.jsonl");
  assert.equal(
    resolveRuntimePathFromRepoRoot(absolutePath, {
      repoRoot,
      fieldPath: "runtimeLogPath",
    }),
    absolutePath,
  );
});

test("missing, empty, and placeholder reminder prompts are rejected", async () => {
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-prompt-resolution-"),
  );

  try {
    await mkdir(join(tempDirectory, "prompts"), { recursive: true });
    const promptPath = join(tempDirectory, "prompts", "missing.md");

    assert.throws(
      () =>
        resolvePromptAsset(promptPath, {
          kind: "Reminder prompt asset 'test.soft'",
          templateMode: "plain-text",
        }),
      (error: unknown) => {
        assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
        assert.match(String(error), /Missing prompt asset/u);
        return true;
      },
    );

    await writeFile(promptPath, "{{legacy_placeholder}}\n", "utf8");
    assert.throws(
      () =>
        resolvePromptAsset(promptPath, {
          kind: "Reminder prompt asset 'test.soft'",
          templateMode: "plain-text",
        }),
      (error: unknown) => {
        assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
        assert.match(String(error), /must not contain template placeholders/u);
        return true;
      },
    );

    await writeFile(promptPath, "   \n", "utf8");
    assert.throws(
      () =>
        resolvePromptAsset(promptPath, {
          kind: "Reminder prompt asset 'test.soft'",
          templateMode: "plain-text",
        }),
      (error: unknown) => {
        assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
        assert.match(String(error), /must contain non-empty prompt text/u);
        return true;
      },
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("loadRuntimeConfig rejects missing prompt paths from external config files", async () => {
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-missing-prompts-"),
  );

  try {
    await mkdir(join(tempDirectory, "prompts"), { recursive: true });
    const configPath = join(tempDirectory, "runtime-config.json");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          version: 1,
          promptPath: join(tempDirectory, "prompts", "missing-compaction.md"),
          compactionModels: ["config-primary"],
          runtimeLogPath: "logs/runtime.jsonl",
          seamLogPath: "logs/seam.jsonl",
          reminder: {
            promptPaths: {
              compactOnly: {
                soft: join(tempDirectory, "prompts", "missing-soft.md"),
                hard: join(tempDirectory, "prompts", "missing-hard.md"),
              },
              deleteAllowed: {
                soft: join(tempDirectory, "prompts", "missing-soft-delete.md"),
                hard: join(tempDirectory, "prompts", "missing-hard-delete.md"),
              },
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await assert.rejects(
      () =>
        loadRuntimeConfig({
          [RUNTIME_CONFIG_ENV.configPath]: configPath,
        }),
      (error: unknown) => {
        assert.ok(error instanceof OpencodeContextCompressionRuntimeConfigError);
        assert.match(String(error), /Missing prompt asset/u);
        return true;
      },
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("loadRuntimeConfig accepts JSONC comments and trailing commas from external config files", async () => {
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-jsonc-config-"),
  );

  try {
    await mkdir(join(tempDirectory, "prompts"), { recursive: true });
    await mkdir(join(tempDirectory, "logs"), { recursive: true });

    const configPath = join(tempDirectory, "runtime-config.jsonc");
    const compactionPromptPath = join(tempDirectory, "prompts", "compaction.md");
    const softCompactOnlyPath = join(tempDirectory, "prompts", "reminder-soft-compact-only.md");
    const hardCompactOnlyPath = join(tempDirectory, "prompts", "reminder-hard-compact-only.md");
    const softDeleteAllowedPath = join(tempDirectory, "prompts", "reminder-soft-delete-allowed.md");
    const hardDeleteAllowedPath = join(tempDirectory, "prompts", "reminder-hard-delete-allowed.md");

    await Promise.all([
      writeFile(compactionPromptPath, "Summarize the marked content carefully.\n", "utf8"),
      writeFile(softCompactOnlyPath, "Compact-only soft reminder.\n", "utf8"),
      writeFile(hardCompactOnlyPath, "Compact-only hard reminder.\n", "utf8"),
      writeFile(softDeleteAllowedPath, "Delete-allowed soft reminder.\n", "utf8"),
      writeFile(hardDeleteAllowedPath, "Delete-allowed hard reminder.\n", "utf8"),
    ]);

    await writeFile(
      configPath,
      `{
  // JSONC comments must remain supported here.
  "version": 1,
  "allowDelete": true,
  "promptPath": ${JSON.stringify(compactionPromptPath)},
  "compactionModels": ["jsonc-primary",],
  "runtimeLogPath": "logs/runtime-events.jsonl",
  "seamLogPath": "logs/seam-observation.jsonl",
  "reminder": {
    "promptPaths": {
      "compactOnly": {
        "soft": ${JSON.stringify(softCompactOnlyPath)},
        "hard": ${JSON.stringify(hardCompactOnlyPath)},
      },
      "deleteAllowed": {
        "soft": ${JSON.stringify(softDeleteAllowedPath)},
        "hard": ${JSON.stringify(hardDeleteAllowedPath)},
      },
    },
  },
}
`,
      "utf8",
    );

    const runtimeConfig = await loadRuntimeConfig({
      [RUNTIME_CONFIG_ENV.configPath]: configPath,
    });

    assert.equal(runtimeConfig.allowDelete, true);
    assert.deepEqual(runtimeConfig.models, ["jsonc-primary"]);
    assert.equal(runtimeConfig.promptPath, compactionPromptPath);
    assert.equal(
      runtimeConfig.runtimeLogPath,
      join(resolveRuntimeConfigRepoRoot(), "logs", "runtime-events.jsonl"),
    );
    assert.equal(
      runtimeConfig.reminder.prompts.deleteAllowed.hard.path,
      hardDeleteAllowedPath,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
