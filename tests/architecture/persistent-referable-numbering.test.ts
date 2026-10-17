import assert from "node:assert/strict";
import { test } from "node:test";
import { replayHistoryFromSources } from "../../src/history/history-replay-reader.js";
import { buildReferableMarkerIds, parseVisibleId } from "../../src/identity/visible-sequence.js";
import { buildCompressionInspectListing } from "../../src/projection/compression-inspect.js";
import { buildCompressionRecallOverrides } from "../../src/projection/compression-recall.js";
import { createFlatPolicyEngine } from "../../src/projection/policy-engine.js";
import { renderProjectionMessages } from "../../src/projection/rendering.js";
import type { ProjectionState } from "../../src/projection/types.js";

const visibleNumbers = [1, 3, 4, 7, 8];
const hostId = (seq: number) => `compressible_${String(seq).padStart(6, "0")}_ab`;

function fixture(mode: "compact" | "delete" = "compact"): ProjectionState {
  const history = replayHistoryFromSources({
    sessionId: "numbering", toolHistory: [],
    hostHistory: visibleNumbers.map((_, index) => ({
      sequence: index + 1,
      message: { info: { id: `msg-${index + 1}`, role: "assistant" }, parts: [{ type: "text", text: `original-${index + 1}` }] },
    })),
  });
  const messagePolicies = history.messages.map((message, index) => ({
    canonicalId: message.canonicalId, sequence: message.sequence, role: message.role,
    visibleKind: "compressible" as const, tokenCount: 10,
    visibleId: hostId(visibleNumbers[index]), visibleSeq: visibleNumbers[index], visibleBase62: "ab",
  }));
  return {
    sessionId: history.sessionId, history, messagePolicies, conflicts: [], visibleIdAllocations: [], failedToolMessageIds: new Map(),
    markTree: { conflicts: [], marks: [{ markId: "summary", mode, startSequence: 3, endSequence: 4,
      startVisibleMessageId: hostId(4), endVisibleMessageId: hostId(7), sourceMessageId: "mark", sourceSequence: 5, depth: 0, children: [] }] },
    resultGroups: [{ markId: "summary", mode, sourceStartSeq: 3, sourceEndSeq: 4, executionMode: mode,
      fragmentCount: 1, createdAt: "t", payloadSha256: "hash", applied: true,
      fragments: [{ fragmentIndex: 0, sourceStartSeq: 3, sourceEndSeq: 4, replacementText: "retained summary" }] }],
  };
}

function render(state: ProjectionState) {
  return renderProjectionMessages({ history: state.history, messagePolicies: state.messagePolicies, markTree: state.markTree,
    resultGroupsByMarkId: new Map(state.resultGroups.map((group) => [group.markId, group])),
    failedToolMessageIds: state.failedToolMessageIds, replacementGateOpen: true }).messages;
}

test("summary and inspect use permanent endpoints across numbering holes", () => {
  const state = fixture();
  const messages = render(state);
  const markers = buildReferableMarkerIds({ markId: "summary", fragmentIndex: 0, sourceStartSeq: 4, sourceEndSeq: 7 });
  const summary = messages.find((message) => message.source === "result-group");
  assert.equal(summary?.visibleId, markers.startId);
  assert.equal(summary?.contentText, `[${markers.startId}~${markers.endId}] retained summary`);
  assert.deepEqual(messages.filter((message) => message.source === "canonical").map((message) => message.canonicalId), ["msg-1", "msg-2", "msg-5"]);
  for (const mode of ["compact", "delete"] as const) {
    const output = buildCompressionInspectListing({ messages, policies: state.messagePolicies, resultGroups: state.resultGroups, to: hostId(8), mode });
    assert.ok(output);
    const rows = output.split("\n").slice(3).map((row) => row.split("\t"));
    assert.deepEqual(rows.map((row) => row.slice(0, 3)), [
      ["compressible", "000001_ab", "000003_ab"],
      ["referable", markers.startId, markers.endId],
      ["compressible", "000008_ab", "000008_ab"],
    ]);
    const numbers = rows.map((row) => row.slice(1, 3).map((id) => parseVisibleId(id).visibleSeq));
    assert.ok(numbers.every(([start], index) => index === 0 || start > numbers[index - 1][1]));
  }
});

test("new summary endpoints resolve to replay coordinates while old shifted endpoints fail", () => {
  const state = fixture();
  for (const [start, end, accepted] of [[4, 7, true], [3, 4, false]] as const) {
    const markers = buildReferableMarkerIds({ markId: "summary", fragmentIndex: 0, sourceStartSeq: start, sourceEndSeq: end });
    const history = { ...state.history, marks: [{ markId: "next", mode: "delete" as const, sourceSequence: 6,
      sourceMessageId: "mark-next", startVisibleMessageId: markers.startId, endVisibleMessageId: markers.endId }] };
    const tree = createFlatPolicyEngine().buildMarkTree({ history, resultGroups: state.resultGroups,
      visibleIdsByCanonicalId: new Map(state.messagePolicies.map((policy) => [policy.canonicalId, policy.visibleId])) });
    assert.equal(tree.marks.length, accepted ? 1 : 0);
    assert.equal(tree.conflicts.length, accepted ? 0 : 1);
    if (accepted) assert.deepEqual([tree.marks[0].startSequence, tree.marks[0].endSequence], [3, 4]);
  }
});

function recall(state: ProjectionState, from: string, to: string) {
  const value = { ...state, history: { ...state.history, compressionRecallToolCalls: [{ sequence: 6, sourceMessageId: "recall",
    outcome: "accepted" as const, recallId: "recall", startVisibleMessageId: from, endVisibleMessageId: to }] } };
  return JSON.parse(buildCompressionRecallOverrides(value, render(value))[0].output);
}

test("recall selects permanent host and summary ranges and preserves numbering holes", () => {
  const state = fixture();
  const markers = buildReferableMarkerIds({ markId: "summary", fragmentIndex: 0, sourceStartSeq: 4, sourceEndSeq: 7 });
  const summary = recall(state, markers.startId, markers.endId);
  assert.equal(summary.ok, true);
  assert.match(summary.transcript, /original-3/);
  assert.match(summary.transcript, /original-4/);
  assert.doesNotMatch(summary.transcript, /original-2|original-5/);
  assert.match(summary.transcript, /### 4\./);
  assert.match(summary.transcript, /### 7\./);
  const host = recall(state, hostId(3), hostId(3));
  assert.match(host.transcript, /original-2/);
  assert.doesNotMatch(host.transcript, /original-3/);
  assert.equal(recall(state, hostId(5), hostId(6)).errorCode, "TARGET_NOT_FOUND");
});

test("delete checks permanent ranges rather than replay positions", () => {
  const state = fixture("delete");
  const retired = recall(state, hostId(7), hostId(8));
  assert.equal(retired.errorCode, "RANGE_RETIRED");
  assert.deepEqual(retired.details.retiredRanges, [{ fromSeq: 4, toSeq: 7 }]);
  assert.equal(recall(state, hostId(3), hostId(3)).ok, true);
  assert.equal(recall(state, hostId(8), hostId(8)).ok, true);
});
