import assert from "node:assert/strict";
import test from "node:test";

import { listRepoFiles, listVisibleRepoFiles, readRepoFile } from "./cutover-test-helpers.js";

test("repo-owned runtime config, prompt assets, and env precedence contract are defined inside this repo", async () => {
  const configFiles = listVisibleRepoFiles(await listRepoFiles("src/config"));
  const promptFiles = listVisibleRepoFiles(await listRepoFiles("prompts"));
  const readme = await readRepoFile("README.md");
  const readmeZh = await readRepoFile("readme.zh.md");
  const gaps: string[] = [];

  if (configFiles.length === 0) {
    gaps.push(
      "Expected repo-owned runtime config sources under `src/config/`, but that directory is still absent, so config ownership and precedence are not defined inside this repo.",
    );
  } else {
    const configSources = await Promise.all(configFiles.map((filePath) => readRepoFile(filePath)));
    const hasEnvOverrideSurface = configSources.some((source) => source.includes("process.env"));
    if (!hasEnvOverrideSurface) {
      gaps.push(
        `Expected explicit env override handling inside ${configFiles.join(", ")}, but no config source references process.env yet.`,
      );
    }
  }

  if (promptFiles.length === 0) {
    gaps.push("Expected repo-owned prompt assets under `prompts/`, but no prompt files exist yet.");
  }

  const legacyConfigReferences = ["README.md", "readme.zh.md"].filter((filePath) => {
    const source = filePath === "README.md" ? readme : readmeZh;
    return source.includes("config/dcp-runtime.json");
  });
  if (legacyConfigReferences.length > 0) {
    gaps.push(
      `Legacy runtime-config ownership is still documented via \`config/dcp-runtime.json\` in: ${legacyConfigReferences.join(", ")}.`,
    );
  }

  if (gaps.length > 0) {
    assert.fail([
      "Cutover gap: repo-owned runtime config/prompt/env ownership is not finished.",
      ...gaps.map((gap) => `- ${gap}`),
    ].join("\n"));
  }
});
