import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPRESSION_INSPECT_EXTERNAL_CONTRACT,
  createCompressionInspectTool,
  deserializeCompressionInspectResult,
  executeCompressionInspect,
  serializeCompressionInspectResult,
  validateCompressionInspectInput,
  type CompressionInspectToolInvocationContext,
} from "../../../src/tools/compression-inspect.js";
import { buildReferableMarkerIds } from "../../../src/identity/visible-sequence.js";
import type { CompleteResultGroup } from "../../../src/state/result-group-repository.js";
import type {
  MessageProjectionPolicy,
  ProjectedPromptMessage,
} from "../../../src/projection/types.js";
import {
  buildCompressionInspectDeleteEntries,
  groupCompressionInspectEntries,
  type CompressionInspectVisibleEntry,
} from "../../../src/projection/compression-inspect.js";

test("compression_inspect validates one visible-id range and returns a placeholder", async () => {
  const valid = validateCompressionInspectInput({
    to: "compressible_000004_b2",
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.mode, "compact");
    assert.equal(valid.value.mergeAdjacent, true);
  }

  const deleteMode = validateCompressionInspectInput({
    to: "compressible_000004_b2",
    mode: "delete",
  });
  assert.equal(deleteMode.ok, true);
  if (deleteMode.ok) {
    assert.equal(deleteMode.value.mode, "delete");
  }

  const invalidMode = validateCompressionInspectInput({
    to: "compressible_000004_b2",
    mode: "purge",
  });
  assert.equal(invalidMode.ok, false);
  if (!invalidMode.ok) {
    assert.equal(invalidMode.result.errorCode, "INVALID_RANGE");
    assert.match(invalidMode.result.message, /compression_inspect mode/u);
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
    { id: "compressible_000001_a1", visibleKind: "compressible", role: "tool", tokens: 0 },
    { id: "compressible_000002_b2", visibleKind: "compressible", role: "tool", tokens: 7 },
    { id: "protected_000003_c3", visibleKind: "protected", role: "user", tokens: 0 },
    { id: "referable_000004_d4", visibleKind: "referable", role: "assistant", tokens: 0 },
    { id: "compressible_000005_e5", visibleKind: "compressible", role: "assistant", tokens: 2 },
    { id: "compressible_000006_f6", visibleKind: "compressible", role: "assistant", tokens: 3 },
    { id: "protected_000007_g7", visibleKind: "protected", role: "user", tokens: 0 },
    { id: "compressible_000008_h8", visibleKind: "compressible", role: "assistant", tokens: 5 },
  ];

  const sections = groupCompressionInspectEntries(entries);
  assert.deepEqual(sections, [
    {
      from: "000005_e5",
      to: "000008_h8",
      totalTokens: 10,
      atomCount: 2,
      atoms: [
        {
          from: "000005_e5",
          to: "000006_f6",
          tokens: 5,
        },
        {
          from: "000008_h8",
          to: "000008_h8",
          tokens: 5,
        },
      ],
    },
    {
      from: "000002_b2",
      to: "000002_b2",
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

test("compression_inspect delete mode lists fragments, users and compressible ranges in position order", () => {
  const markId = "mark-delete-fixture";
  const markers = buildReferableMarkerIds({
    markId,
    fragmentIndex: 0,
    sourceStartSeq: 2,
    sourceEndSeq: 2,
  });

  const policies: readonly MessageProjectionPolicy[] = [
    createPolicy({ sequence: 1, visibleId: "protected_000001_a1", visibleKind: "protected", role: "user", tokenCount: 0 }),
    createPolicy({ sequence: 2, visibleId: "compressible_000002_b2", visibleKind: "compressible", role: "tool", tokenCount: 40 }),
    createPolicy({ sequence: 3, visibleId: "protected_000003_c3", visibleKind: "protected", role: "user", tokenCount: 0 }),
    createPolicy({ sequence: 4, visibleId: "compressible_000004_d4", visibleKind: "compressible", role: "assistant", tokenCount: 20 }),
  ];

  const messages: readonly ProjectedPromptMessage[] = [
    {
      source: "canonical",
      role: "user",
      canonicalId: "canonical-1",
      visibleKind: "protected",
      visibleId: "protected_000001_a1",
      contentText: "[protected_000001_a1] short ask",
    },
    {
      source: "result-group",
      role: "assistant",
      sourceMarkId: markId,
      visibleKind: "referable",
      visibleId: markers.startId,
      contentText: `[${markers.startId}~${markers.endId}] summary`,
    },
    {
      source: "canonical",
      role: "user",
      canonicalId: "canonical-3",
      visibleKind: "protected",
      visibleId: "protected_000003_c3",
      contentText: "[protected_000003_c3] another ask",
    },
    {
      source: "canonical",
      role: "assistant",
      canonicalId: "canonical-4",
      visibleKind: "compressible",
      visibleId: "compressible_000004_d4",
      contentText: "[compressible_000004_d4] long answer",
    },
  ];

  const resultGroups: readonly CompleteResultGroup[] = [
    {
      markId,
      mode: "compact",
      sourceStartSeq: 2,
      sourceEndSeq: 2,
      fragmentCount: 1,
      executionMode: "test",
      createdAt: "2026-09-29T00:00:00.000Z",
      payloadSha256: "0".repeat(64),
      applied: true,
      fragments: [
        {
          fragmentIndex: 0,
          sourceStartSeq: 2,
          sourceEndSeq: 2,
          replacementText: "summary",
        },
      ],
    },
  ];

  const entries = buildCompressionInspectDeleteEntries({
    messages,
    policies,
    resultGroups,
    to: "compressible_000004_d4",
  });

  assert.deepEqual(entries, [
    { kind: "user", from: "000001_a1", to: "000001_a1", tokens: Math.ceil(messages[0]!.contentText.length / 4) },
    { kind: "fragment", from: markers.startId, to: markers.endId, tokens: Math.ceil(messages[1]!.contentText.length / 4) },
    { kind: "user", from: "000003_c3", to: "000003_c3", tokens: Math.ceil(messages[2]!.contentText.length / 4) },
    { kind: "compressible", from: "000004_d4", to: "000004_d4", tokens: Math.ceil(messages[3]!.contentText.length / 4) },
  ]);
  const precounted = buildCompressionInspectDeleteEntries({
    messages: messages.map((message, index) => ({ ...message, visibleTokenCount: index + 1 })),
    policies, resultGroups, to: "compressible_000004_d4",
  });
  assert.deepEqual(precounted.map((entry) => entry.tokens), [1, 2, 3, 4]);
});

test("compression_inspect delete mode round-trips through the serialized result", () => {
  const serialized = serializeCompressionInspectResult({
    ok: true,
    mode: "delete",
    entries: [
      {
        kind: "fragment",
        from: "referable_000002_wq",
        to: "referable_000004_wq",
        tokens: 120,
      },
      { kind: "user", from: "000005_y9", to: "000005_y9", tokens: 0 },
    ],
    totalTokens: 120,
  });

  assert.deepEqual(deserializeCompressionInspectResult(serialized), {
    ok: true,
    mode: "delete",
    entries: [
      {
        kind: "fragment",
        from: "referable_000002_wq",
        to: "referable_000004_wq",
        tokens: 120,
      },
      { kind: "user", from: "000005_y9", to: "000005_y9", tokens: 0 },
    ],
    totalTokens: 120,
  });
});

function createPolicy(input: {
  readonly sequence: number;
  readonly visibleId: string;
  readonly visibleKind: "protected" | "compressible" | "referable";
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly tokenCount: number;
}): MessageProjectionPolicy {
  const [, seq6, base62] = input.visibleId.split("_");
  return {
    canonicalId: `canonical-${input.sequence}`,
    sequence: input.sequence,
    role: input.role,
    visibleKind: input.visibleKind,
    tokenCount: input.tokenCount,
    visibleId: input.visibleId,
    visibleSeq: Number.parseInt(seq6 ?? "", 10),
    visibleBase62: base62 ?? "",
  };
}

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
