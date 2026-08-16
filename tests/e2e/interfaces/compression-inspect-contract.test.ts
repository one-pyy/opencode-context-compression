import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPRESSION_INSPECT_EXTERNAL_CONTRACT,
  createCompressionInspectTool,
  deserializeCompressionInspectResult,
  executeCompressionInspect,
  validateCompressionInspectInput,
  type CompressionInspectToolInvocationContext,
} from "../../../src/tools/compression-inspect.js";
import {
  groupCompressionInspectEntries,
  type CompressionInspectVisibleEntry,
} from "../../../src/projection/compression-inspect.js";

test("compression_inspect validates one visible-id range and returns a placeholder", async () => {
  const valid = validateCompressionInspectInput({
    to: "compressible_000004_b2",
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.mergeAdjacent, true);
  }

  const unmerged = validateCompressionInspectInput({
    to: "compressible_000004_b2",
    mergeAdjacent: false,
  });
  assert.equal(unmerged.ok, true);
  if (unmerged.ok) {
    assert.equal(unmerged.value.mergeAdjacent, false);
  }

  const invalid = validateCompressionInspectInput({
    target: {
      to: "compressible_000004_b2",
    },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.result.errorCode, "INVALID_RANGE");
    assert.match(invalid.result.message, /compression_inspect to/u);
  }

  const result = await executeCompressionInspect(
    {
      to: "compressible_000004_b2",
    },
    createInvocationContext("session-inspect"),
    {
      createInspectID(input) {
        return `inspect-for-${input.to}`;
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    inspectId: "inspect-for-compressible_000004_b2",
  });
  assert.equal(
    COMPRESSION_INSPECT_EXTERNAL_CONTRACT.relationToRuntime.tokenCounts,
    "uses ProjectionState.messagePolicies from messages.transform and never recalculates tokens in the tool",
  );
});

test("compression_inspect groups referable sections with protected-delimited atoms", () => {
  const entries: readonly CompressionInspectVisibleEntry[] = [
    { id: "compressible_000001_a1", visibleKind: "compressible", tokens: 0 },
    { id: "compressible_000002_b2", visibleKind: "compressible", tokens: 7 },
    { id: "protected_000003_c3", visibleKind: "protected", tokens: 0 },
    { id: "referable_000004_d4", visibleKind: "referable", tokens: 0 },
    { id: "compressible_000005_e5", visibleKind: "compressible", tokens: 2 },
    { id: "compressible_000006_f6", visibleKind: "compressible", tokens: 3 },
    { id: "protected_000007_g7", visibleKind: "protected", tokens: 0 },
    { id: "compressible_000008_h8", visibleKind: "compressible", tokens: 5 },
  ];

  const sections = groupCompressionInspectEntries(entries);
  assert.deepEqual(sections, [
    {
      from: "compressible_000005_e5",
      to: "compressible_000008_h8",
      totalTokens: 10,
      atomCount: 2,
      atoms: [
        {
          from: "compressible_000005_e5",
          to: "compressible_000006_f6",
          messageCount: 2,
          tokens: 5,
        },
        {
          from: "compressible_000008_h8",
          to: "compressible_000008_h8",
          messageCount: 1,
          tokens: 5,
        },
      ],
    },
    {
      from: "compressible_000002_b2",
      to: "compressible_000002_b2",
      totalTokens: 7,
      atomCount: 1,
    },
  ]);
});

test("compression_inspect tool serializes the placeholder result", async () => {
  const definition = createCompressionInspectTool({
    createInspectID() {
      return "inspect-serialized-001";
    },
  });

  const payload = await definition.execute(
    {
      to: "compressible_000004_b2",
    },
    {
      sessionID: "session-tool-contract",
      messageID: "msg-tool-contract",
      agent: "atlas",
      directory: "/tmp/plugin-contract",
      worktree: "/tmp/plugin-contract",
      abort: new AbortController().signal,
      metadata() {},
      ask: async () => {},
    },
  );

  assert.deepEqual(deserializeCompressionInspectResult(payload), {
    ok: true,
    inspectId: "inspect-serialized-001",
  });
});

function createInvocationContext(
  sessionID: string,
): CompressionInspectToolInvocationContext {
  return {
    sessionID,
    messageID: "msg-contract",
    agent: "atlas",
    directory: "/tmp/plugin-contract",
    worktree: "/tmp/plugin-contract",
    abort: new AbortController().signal,
  };
}
