import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import { readRepoFile } from "./cutover-test-helpers.js";

const README_PATH = "README.md";
const README_ZH_PATH = "readme.zh.md";
const LIVE_GUIDE_PATH =
  "docs/live-verification-with-mitmproxy-and-debug-log.zh.md";
const INDEX_PATH = ".sisyphus/notepads/INDEX.md";
const DECISION_PATH =
  ".sisyphus/notepads/decisions/2026-04-03_final-repo-owned-operator-contract.md";
const TUTORIAL_PATH =
  ".sisyphus/notepads/tutorials/2026-04-03_repo-owned-operator-and-live-verification-workflow.md";

test("operator docs advertise only the final repo-owned contract", async () => {
  const [readme, readmeZh, liveGuide] = await Promise.all([
    readRepoFile(README_PATH),
    readRepoFile(README_ZH_PATH),
    readRepoFile(LIVE_GUIDE_PATH),
  ]);

  for (const source of [readme, readmeZh]) {
    assert.match(source, /compression_mark/u);
    assert.match(source, /src\/config\/runtime-config\.jsonc/u);
    assert.match(source, /src\/config\/runtime-config\.schema\.json/u);
    assert.match(source, /prompts\/compaction\.md/u);
    assert.match(source, /logs\/runtime-events\.jsonl/u);
    assert.match(source, /logs\/seam-observation\.jsonl/u);
    assert.match(source, /route=keep/u);
    assert.match(source, /route=delete/u);
    assert.match(source, /locks\/<session-id>\.lock/u);
  }

  const forbiddenPatterns = [
    /dcp_execute_compaction/u,
    /dcp_mark_for_compaction/u,
    /\bdcp_mark\b/u,
    /config\/dcp-runtime\.json/u,
    /dcp-compaction\.md/u,
    /dcp-runtime-events\.jsonl/u,
  ];

  for (const source of [readme, readmeZh, liveGuide]) {
    for (const pattern of forbiddenPatterns) {
      assert.doesNotMatch(source, pattern);
    }
  }

  assert.match(
    liveGuide,
    /tests\/cutover\/runtime-config-precedence\.test\.ts/u,
  );
  assert.match(liveGuide, /tests\/cutover\/legacy-independence\.test\.ts/u);
  assert.match(
    liveGuide,
    /tests\/cutover\/docs-and-notepad-contract\.test\.ts/u,
  );
  assert.match(
    liveGuide,
    /tests\/e2e\/plugin-loading-and-compaction\.test\.ts/u,
  );
  assert.match(liveGuide, /tests\/e2e\/delete-route\.test\.ts/u);
  assert.match(liveGuide, /legacy DCP 工具/u);
  assert.match(liveGuide, /默认生产 compaction executor transport/u);
  assert.match(
    liveGuide,
    /真实会话里的 live verification 目前适合确认“插件确实加载了/u,
  );
});

test("target repo notepad records the final operator contract and workflow", async () => {
  await Promise.all([
    access(new URL(`../../${DECISION_PATH}`, import.meta.url)),
    access(new URL(`../../${TUTORIAL_PATH}`, import.meta.url)),
  ]);

  const [index, decision, tutorial] = await Promise.all([
    readRepoFile(INDEX_PATH),
    readRepoFile(DECISION_PATH),
    readRepoFile(TUTORIAL_PATH),
  ]);

  assert.match(
    index,
    /\[decisions\/2026-04-03_final-repo-owned-operator-contract\]/u,
  );
  assert.match(
    index,
    /\[tutorials\/2026-04-03_repo-owned-operator-and-live-verification-workflow\]/u,
  );

  assert.match(decision, /^## final-repo-owned-operator-contract$/mu);
  assert.match(decision, /^### Decision$/mu);
  assert.match(decision, /`compression_mark`/u);
  assert.match(decision, /repo-owned automated tests/u);
  assert.match(decision, /legacy host tools/u);

  assert.match(
    tutorial,
    /^## repo-owned-operator-and-live-verification-workflow$/mu,
  );
  assert.match(tutorial, /^### Use When$/mu);
  assert.match(tutorial, /^### Goal$/mu);
  assert.match(tutorial, /^### Mechanism$/mu);
  assert.match(tutorial, /`README\.md`/u);
  assert.match(tutorial, /`readme\.zh\.md`/u);
  assert.match(
    tutorial,
    /`docs\/live-verification-with-mitmproxy-and-debug-log\.zh\.md`/u,
  );
  assert.match(
    tutorial,
    /`tests\/cutover\/docs-and-notepad-contract\.test\.ts`/u,
  );
});
