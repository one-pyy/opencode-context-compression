import assert from "node:assert/strict";
import test from "node:test";

import {
  listRepoFiles,
  listVisibleRepoFiles,
  listWorkspaceFiles,
  readWorkspaceFile,
} from "./cutover-test-helpers.js";

const STALE_PLAN_PATH =
  ".sisyphus/plans/opencode-context-compression-plugin.md";
const CUTOVER_PLAN_PATH =
  ".sisyphus/plans/opencode-context-compression-full-cutover.md";
const EVIDENCE_DIRECTORY = ".sisyphus/evidence";
const EVIDENCE_PACK_PATH = ".sisyphus/evidence/cutover-9-evidence-pack.txt";
const STATUS_AUDIT_PATH = ".sisyphus/evidence/cutover-9-status-audit.txt";

const REQUIRED_EVIDENCE_FILES = Object.freeze([
  "cutover-2-config-precedence.txt",
  "cutover-3-mark-happy.txt",
  "cutover-4-scheduler-happy.txt",
  "cutover-7-e2e-live-path.txt",
  "cutover-7-legacy-independence.txt",
  "cutover-8-docs.txt",
  "cutover-8-notepad.txt",
  "cutover-9-evidence-pack.txt",
  "cutover-9-status-audit.txt",
]);

const REQUIRED_PROOF_COMMANDS = Object.freeze([
  "node --import tsx --test tests/cutover/compression-mark-contract.test.ts",
  "node --import tsx --test tests/cutover/runtime-config-precedence.test.ts",
  "node --import tsx --test tests/cutover/scheduler-live-path.test.ts",
  "node --import tsx --test tests/cutover/legacy-independence.test.ts",
  "node --import tsx --test tests/cutover/docs-and-notepad-contract.test.ts",
  "node --import tsx --test tests/e2e/plugin-loading-and-compaction.test.ts",
  "npm run typecheck",
]);

const CURRENT_CUTOVER_TESTS = Object.freeze([
  "tests/cutover/compression-mark-contract.test.ts",
  "tests/cutover/runtime-config-precedence.test.ts",
  "tests/cutover/scheduler-live-path.test.ts",
  "tests/cutover/legacy-independence.test.ts",
  "tests/cutover/docs-and-notepad-contract.test.ts",
]);

test("final evidence pack enumerates the current executable cutover proof surface", async () => {
  const [workspaceEvidenceFiles, repoCutoverTests, evidencePack] =
    await Promise.all([
      listWorkspaceFiles(EVIDENCE_DIRECTORY),
      listRepoFiles("tests/cutover"),
      readWorkspaceFile(EVIDENCE_PACK_PATH),
    ]);

  const visibleEvidenceFiles = listVisibleRepoFiles(workspaceEvidenceFiles);
  const visibleCutoverTests = listVisibleRepoFiles(repoCutoverTests);

  for (const fileName of REQUIRED_EVIDENCE_FILES) {
    assert.ok(
      visibleEvidenceFiles.includes(`${EVIDENCE_DIRECTORY}/${fileName}`),
      `expected ${fileName} to exist under ${EVIDENCE_DIRECTORY}`,
    );
    assert.match(evidencePack, new RegExp(escapeForRegExp(fileName), "u"));
  }

  for (const testPath of CURRENT_CUTOVER_TESTS) {
    assert.ok(
      visibleCutoverTests.includes(testPath),
      `expected current cutover test '${testPath}' to exist`,
    );
    assert.match(evidencePack, new RegExp(escapeForRegExp(testPath), "u"));
  }

  for (const command of REQUIRED_PROOF_COMMANDS) {
    assert.match(evidencePack, new RegExp(escapeForRegExp(command), "u"));
  }

  assert.match(
    evidencePack,
    /public tool proof comes from the current `compression_mark` cutover test/u,
  );
  assert.match(
    evidencePack,
    /config precedence proof comes from the repo-owned runtime config audit/u,
  );
  assert.match(
    evidencePack,
    /scheduler live path proof comes from the `chat\.params` scheduler audit/u,
  );
  assert.match(
    evidencePack,
    /legacy independence proof comes from the absence and fixture audit/u,
  );
  assert.match(
    evidencePack,
    /docs and notepad proof come from the Task 8 contract audit/u,
  );
});

test("status audit derives current cutover truth from evidence instead of inherited checkbox state", async () => {
  const [stalePlan, cutoverPlan, statusAudit] = await Promise.all([
    readWorkspaceFile(STALE_PLAN_PATH),
    readWorkspaceFile(CUTOVER_PLAN_PATH),
    readWorkspaceFile(STATUS_AUDIT_PATH),
  ]);

  for (const uncheckedLinePrefix of [
    "- [ ] F1. Plan Compliance Audit",
    "- [ ] F2. Code Quality Review",
    "- [ ] F3. Real Manual QA",
    "- [ ] F4. Scope Fidelity Check",
  ]) {
    assert.match(
      stalePlan,
      new RegExp(`^${escapeForRegExp(uncheckedLinePrefix)}(?:\\s+—.*)?$`, "mu"),
    );
  }

  for (const uncheckedLinePrefix of [
    "- [ ] F1. Cutover Compliance Audit",
    "- [ ] F2. Code Quality Review",
    "- [ ] F3. Agent-Executed End-to-End QA",
    "- [ ] F4. Legacy Independence Scope Check",
  ]) {
    assert.match(
      cutoverPlan,
      new RegExp(`^${escapeForRegExp(uncheckedLinePrefix)}(?:\\s+—.*)?$`, "mu"),
    );
  }

  assert.match(
    statusAudit,
    /Derived only from current cutover evidence files and passing proof commands/u,
  );
  assert.match(
    statusAudit,
    /Does not depend on inherited completion in `\.sisyphus\/plans\/opencode-context-compression-plugin\.md`/u,
  );
  assert.match(
    statusAudit,
    /Does not depend on unchecked Final Verification Wave items F1-F4 in either plan/u,
  );
  assert.match(
    statusAudit,
    /Deferred outside this audit: the owner-requested real-session runtime test and the full Final Wave review/u,
  );
  assert.match(
    statusAudit,
    /Current proof basis: `cutover-9-evidence-pack\.txt`, `npm run typecheck`, and the cutover test suite listed there/u,
  );
});

function escapeForRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
