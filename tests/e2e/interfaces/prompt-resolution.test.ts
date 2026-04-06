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

test("prompt resolution selects reminder variants by severity and allowDelete", () => {
  const runtimeConfig = loadRuntimeConfig({});

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

    assert.throws(
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
