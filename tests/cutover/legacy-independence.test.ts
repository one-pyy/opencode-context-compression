import assert from "node:assert/strict";
import test from "node:test";

import { CANONICAL_CONTRACT_FILES, collectAuditHits, formatAuditHits } from "./cutover-test-helpers.js";

test("canonical plugin contract is free of legacy DCP tool names and old runtime ownership references", async () => {
  const hits = await collectAuditHits(CANONICAL_CONTRACT_FILES, [
    {
      pattern: /\bdcp_execute_compaction\b/u,
      reason: "old public executor tool name remains in the canonical plugin contract",
    },
    {
      pattern: /\bdcp_mark_for_compaction\b/u,
      reason: "old public mark tool name remains in the canonical plugin contract",
    },
    {
      pattern: /\bdcp_mark\b/u,
      reason: "legacy public mark alias remains in the canonical plugin contract",
    },
    {
      pattern: /config\/dcp-runtime\.json/u,
      reason: "old runtime config path remains in the canonical plugin contract",
    },
    {
      pattern: /opencode-dcp-fork/u,
      reason: "old fork ownership still appears in the canonical plugin contract",
    },
  ]);

  if (hits.length > 0) {
    assert.fail(
      [
        "Cutover gap: canonical plugin entrypoints and docs still depend on legacy DCP names or ownership references.",
        formatAuditHits("Forbidden legacy references", hits),
      ].join("\n"),
    );
  }
});
