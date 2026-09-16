import assert from "node:assert/strict";
import { test } from "node:test";
import { replayHistoryFromSources } from "../../src/history/history-replay-reader.js";
import { buildCompressionRecallOverrides } from "../../src/projection/compression-recall.js";
import { renderProjectionMessages } from "../../src/projection/rendering.js";
import type { ProjectionState } from "../../src/projection/types.js";
import { deserializeCompressionRecallResult } from "../../src/tools/compression-recall/contract.js";

const id = (seq: number) => `compressible_${String(seq).padStart(6, "0")}_aa`;

function fixture(from = 2, to = 3, mode: "compact" | "delete" = "delete", applied = false): ProjectionState {
  const history = replayHistoryFromSources({
    sessionId: "recall-test", toolHistory: [],
    hostHistory: [1, 2, 3, 4].map((sequence) => ({ sequence, message: {
      info: { id: `h${sequence}`, role: "assistant" },
      parts: [{ type: "text", text: `original-${sequence}` }],
    } })),
    compressionRecallToolCalls: [{ sequence: 5, sourceMessageId: "recall-call", outcome: "accepted",
      recallId: "recall-fixture", startVisibleMessageId: id(from), endVisibleMessageId: id(to) }],
  });
  return {
    sessionId: history.sessionId, history, conflicts: [], visibleIdAllocations: [], failedToolMessageIds: new Map(),
    messagePolicies: history.messages.map((message) => ({
      canonicalId: message.canonicalId, sequence: message.sequence, role: message.role,
      visibleKind: "compressible", tokenCount: 1, visibleId: id(message.sequence),
      visibleSeq: message.sequence, visibleBase62: "aa",
    })),
    markTree: { conflicts: [], marks: [{ markId: "group", mode, startSequence: 2, endSequence: 3,
      startVisibleMessageId: id(2), endVisibleMessageId: id(3), sourceMessageId: "mark-call",
      sourceSequence: 4, depth: 0, children: [] }] },
    resultGroups: [{ markId: "group", mode, executionMode: mode, sourceStartSeq: 2, sourceEndSeq: 3,
      createdAt: "2026-09-16", fragmentCount: 1, payloadSha256: "fixture", applied,
      fragments: [{ fragmentIndex: 0, sourceStartSeq: 2, sourceEndSeq: 3, replacementText: "retained facts" }] }],
  };
}

function recall(state: ProjectionState, gate = false) {
  const rendered = renderProjectionMessages({
    history: state.history, messagePolicies: state.messagePolicies, markTree: state.markTree,
    resultGroupsByMarkId: new Map(state.resultGroups.map((group) => [group.markId, group])),
    failedToolMessageIds: state.failedToolMessageIds, replacementGateOpen: gate,
  }).messages;
  const overrides = buildCompressionRecallOverrides(state, rendered);
  assert.equal(overrides.length, 1);
  return deserializeCompressionRecallResult(overrides[0].output);
}

for (const [from, to] of [[2, 3], [2, 2], [1, 2], [3, 4], [1, 4]]) {
  test(`effective delete refuses the entire overlapping range ${from}..${to}`, () => {
    const result = recall(fixture(from, to), true);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Expected retirement failure");
    assert.equal(result.errorCode, "RANGE_RETIRED");
    assert.deepEqual(result.details?.retiredRanges, [{ fromSeq: 2, toSeq: 3 }]);
    assert.doesNotMatch(JSON.stringify(result), /original-/);
  });
}

test("adjacent ranges and compact-covered originals remain recallable", () => {
  for (const state of [fixture(1, 1), fixture(4, 4), fixture(2, 3, "compact")]) {
    const result = recall(state, true);
    assert.ok(result.ok && "transcript" in result);
    assert.match(result.transcript, /original-/);
  }
});

test("pending, failed, and unused delete results do not retire originals", () => {
  const state = fixture();
  for (const value of [state, { ...state, resultGroups: [] }, { ...state, markTree: { marks: [], conflicts: [] } }]) {
    const result = recall(value, value !== state);
    assert.ok(result.ok && "transcript" in result);
    assert.match(result.transcript, /original-2/);
  }
});

test("persisted delete retirement survives a closed gate and superseding projection", () => {
  const state = fixture(2, 3, "delete", true);
  for (const value of [state, { ...state, markTree: { marks: [], conflicts: [] } }]) {
    const result = recall(value);
    assert.ok(!result.ok);
    assert.equal(result.errorCode, "RANGE_RETIRED");
  }
});

test("an earlier accepted recall is rechecked when delete takes effect", () => {
  const state = fixture();
  assert.equal(recall(state).ok, true);
  assert.equal(recall(state, true).ok, false);
});

test("invalid and missing ranges keep their error semantics", () => {
  const reversed = recall(fixture(3, 2), true);
  assert.ok(!reversed.ok);
  assert.equal(reversed.errorCode, "INVALID_RANGE");
  const missing = recall(fixture(8, 9), true);
  assert.ok(!missing.ok);
  assert.equal(missing.errorCode, "TARGET_NOT_FOUND");
});
