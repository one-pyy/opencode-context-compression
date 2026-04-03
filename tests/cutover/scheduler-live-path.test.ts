import assert from "node:assert/strict";
import test from "node:test";

import { findProductionCallSites, formatAuditHits, readRepoFile } from "./cutover-test-helpers.js";

test("live plugin wiring reaches repo-owned mark persistence and compaction runner paths", async () => {
  const entrypointSource = await readRepoFile("src/index.ts");
  const persistMarkCallSites = await findProductionCallSites("persistMark", {
    excludeFiles: ["src/marks/mark-service.ts"],
  });
  const runCompactionBatchCallSites = await findProductionCallSites("runCompactionBatch", {
    excludeFiles: ["src/compaction/runner.ts"],
  });
  const gaps: string[] = [];

  if (!entrypointSource.includes('hooks["chat.params"]')) {
    gaps.push(
      "`src/index.ts` never overrides `hooks[\"chat.params\"]`, so the live plugin entrypoint still returns the noop observation seam instead of a repo-owned scheduler hook.",
    );
  }

  if (persistMarkCallSites.length === 0) {
    gaps.push("No production caller reaches `persistMark()` outside its own definition, so mark persistence is still internal-only.");
  }

  if (runCompactionBatchCallSites.length === 0) {
    gaps.push(
      "No production caller reaches `runCompactionBatch()` outside its own definition, so the compaction runner still has no live runtime caller path.",
    );
  }

  if (gaps.length > 0) {
    assert.fail(
      [
        "Cutover gap: no live scheduler caller path reaches the repo-owned mark/runner flow yet.",
        ...gaps.map((gap) => `- ${gap}`),
        formatAuditHits("persistMark production callsites", persistMarkCallSites),
        formatAuditHits("runCompactionBatch production callsites", runCompactionBatchCallSites),
      ].join("\n"),
    );
  }
});
