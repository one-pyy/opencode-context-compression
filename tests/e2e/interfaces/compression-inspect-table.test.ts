import assert from "node:assert/strict";
import test from "node:test";
import { buildCompressionInspectListing, buildCompressionInspectOverrides } from "../../../src/projection/compression-inspect.js";
import { buildReferableMarkerIds } from "../../../src/identity/visible-sequence.js";
import type { MessageProjectionPolicy, ProjectedPromptMessage, ProjectionState } from "../../../src/projection/types.js";
import type { CompleteResultGroup } from "../../../src/state/result-group-repository.js";

function fixture() {
  const policies: MessageProjectionPolicy[] = [];
  const messages: ProjectedPromptMessage[] = [];
  const resultGroups: CompleteResultGroup[] = [];
  function original(seq: number, kind: "protected" | "compressible", tokens: number) {
    const id = `${kind}_${String(seq).padStart(6, "0")}_ab`;
    policies.push({ canonicalId: `msg-${seq}`, sequence: seq, role: kind === "protected" ? "user" : "assistant", visibleKind: kind, tokenCount: tokens, visibleId: id, visibleSeq: seq, visibleBase62: "ab" });
    messages.push({ source: "canonical", canonicalId: `msg-${seq}`, role: kind === "protected" ? "user" : "assistant", visibleKind: kind, visibleId: id, contentText: "text", visibleTokenCount: tokens + 100 });
    return id;
  }
  function fragment(seq: number, end: number, tokens: number) {
    for (const sequence of new Set([seq, end])) {
      policies.push({ canonicalId: `msg-${sequence}`, sequence, role: "assistant", visibleKind: "compressible", tokenCount: 10,
        visibleId: `compressible_${String(sequence).padStart(6, "0")}_ab`, visibleSeq: sequence, visibleBase62: "ab" });
    }
    const markId = `mark-${seq}`;
    const markers = buildReferableMarkerIds({ markId, fragmentIndex: 0, sourceStartSeq: seq, sourceEndSeq: end });
    resultGroups.push({ markId, mode: "compact", sourceStartSeq: seq, sourceEndSeq: end, fragmentCount: 1, executionMode: "test", createdAt: "t", payloadSha256: "hash", applied: true, fragments: [{ fragmentIndex: 0, sourceStartSeq: seq, sourceEndSeq: end, replacementText: "summary" }] });
    messages.push({ source: "result-group", role: "assistant", sourceMarkId: markId, visibleKind: "referable", visibleId: markers.startId, contentText: "summary", visibleTokenCount: tokens });
    return markers;
  }
  original(1, "protected", 0);
  fragment(2, 2, 70);
  original(3, "compressible", 9);
  original(4, "protected", 0);
  original(5, "compressible", 20);
  const middle = fragment(6, 7, 50);
  const last = original(8, "compressible", 20);
  original(9, "protected", 0);
  fragment(10, 10, 80);
  const to = original(11, "protected", 0);
  const future = original(12, "compressible", 500);
  return { policies, messages, resultGroups, middle, last, to, future };
}

function rows(output: string | undefined) {
  assert.ok(output);
  assert.equal(output.split("\n")[2], "类型\t起点\t终点\ttoken数");
  return output.split("\n").slice(3).map((line) => line.split("\t"));
}

test("compact TSV includes only first-to-last compressible span and keeps chronological fragments and ranges", () => {
  const input = fixture();
  const output = buildCompressionInspectListing(input);
  assert.deepEqual(rows(output), [
    ["compressible", "000003_ab", "000003_ab", "9"],
    ["compressible", "000005_ab", "000005_ab", "20"],
    ["referable", input.middle.startId, input.middle.endId, "50"],
    ["compressible", "000008_ab", "000008_ab", "20"],
  ]);
  assert.equal(output?.split("\n")[1], "总计\t99");
});

test("delete TSV hides protected users without joining their adjacent ranges and includes edge summaries", () => {
  const input = fixture();
  const output = buildCompressionInspectListing({ ...input, mode: "delete", mergeAdjacent: false });
  const table = rows(output);
  assert.deepEqual(table.map((row) => row[0]), ["referable", "compressible", "compressible", "referable", "compressible", "referable"]);
  assert.ok(table.every((row) => row.length === 4));
  assert.deepEqual(table.filter((row) => row[0] === "compressible").map((row) => row[3]), ["109", "120", "120"]);
  assert.equal(output?.split("\n")[1], `总计\t${table.reduce((sum, row) => sum + Number(row[3]), 0)}`);
});

test("compact mergeAdjacent=false reports consecutive messages separately and reminder/tool share the formatter", () => {
  const input = fixture();
  const common = { ...input, to: input.future, mergeAdjacent: false };
  assert.deepEqual(rows(buildCompressionInspectListing(common)).filter((row) => row[0] === "compressible").slice(-2).map((row) => row[3]), ["20", "500"]);
  const state: ProjectionState = {
    sessionId: "test", history: { sessionId: "test", messages: [], marks: [], compressionMarkToolCalls: [], compressionInspectToolCalls: [{ sequence: 20, sourceMessageId: "inspect", outcome: "accepted", mode: "compact", mergeAdjacent: false, endVisibleMessageId: input.future }] },
    markTree: { marks: [], conflicts: [] }, conflicts: [], visibleIdAllocations: [], resultGroups: input.resultGroups, failedToolMessageIds: new Map(), messagePolicies: input.policies,
  };
  assert.equal(buildCompressionInspectOverrides(state, input.messages)[0]?.output, buildCompressionInspectListing(common));
  const adjacent = input.messages.filter((message) => message.visibleKind === "compressible");
  assert.equal(rows(buildCompressionInspectListing({ ...common, messages: adjacent })).length, 4);
  assert.equal(rows(buildCompressionInspectListing({ ...common, messages: adjacent, mergeAdjacent: true })).length, 1);
});

test("compact TSV empty span, inclusive anchor and invalid range preserve their boundaries", () => {
  const input = fixture();
  assert.deepEqual(rows(buildCompressionInspectListing({ ...input, to: "protected_000001_ab" })), []);
  assert.equal(rows(buildCompressionInspectListing({ ...input, to: "compressible_000005_ab" })).length, 2);
  assert.equal(buildCompressionInspectListing({ ...input, to: "compressible_999999_ab" }), undefined);
  const system: ProjectedPromptMessage = { source: "canonical", role: "system", visibleKind: "protected", visibleId: "protected_000001_ab", contentText: "system" };
  assert.equal(rows(buildCompressionInspectListing({ ...input, mode: "delete", messages: [system, ...input.messages] })).length, 6);
});
