import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompactionRunInputForMark } from "../../src/compaction/replay-run-input.js";
import { createCompactionInputBuilder } from "../../src/compaction/input-builder.js";
import { createOutputValidator } from "../../src/compaction/output-validation.js";
import { buildCompactionResultGroup } from "../../src/compaction/runner/result-group.js";
import { buildUserMessage } from "../../src/compaction/transport/direct-llm.js";
import { replayHistoryFromSources } from "../../src/history/history-replay-reader.js";
import { renderProjectionMessages } from "../../src/projection/rendering.js";
import type { MarkTreeNode, ProjectionState } from "../../src/projection/types.js";
import type { CompleteResultGroup } from "../../src/state/result-group-repository.js";

function mark(id: string, start: number, end: number, children: MarkTreeNode[] = [], mode: "compact" | "delete" = "compact"): MarkTreeNode {
  return {
    markId: id, mode, startSequence: start, endSequence: end, children, depth: 0,
    sourceMessageId: `call-${id}`, sourceSequence: 20,
    startVisibleMessageId: "unused-start", endVisibleMessageId: "unused-end",
    hint: "Keep the user compatibility requirement and unverified deployment status.",
  };
}

function group(id: string, start: number, end: number, text: string, applied = true): CompleteResultGroup {
  return {
    markId: id, mode: "compact", executionMode: "compact", sourceStartSeq: start, sourceEndSeq: end,
    createdAt: "2026-09-15", fragmentCount: 1, payloadSha256: "fixture", applied,
    fragments: [{ fragmentIndex: 0, sourceStartSeq: start, sourceEndSeq: end, replacementText: text }],
  };
}

function state(mode: "compact" | "delete" = "delete"): ProjectionState {
  const roles = ["user", "assistant", "tool", "user", "assistant", "tool", "assistant", "assistant"] as const;
  const texts = ["Keep interfaces compatible.", "RAW-A".repeat(20_000), "RAW-A-result", "Deployment is not verified.", "RAW-B", "RAW-B-result", "Uncovered evidence", ""];
  const history = replayHistoryFromSources({
    sessionId: "delete-test", toolHistory: [],
    hostHistory: roles.map((role, i) => ({ sequence: i + 1, message: {
      info: { id: `h${i + 1}`, role },
      parts: i === 7 ? [{ type: "tool", tool: "opencode_context_compression_notice", callID: "notice", state: { input: {}, output: "REMINDER-NOISE" } }]
        : [{ type: "text", text: texts[i] }],
    } })),
  });
  return {
    sessionId: "delete-test", history, conflicts: [], visibleIdAllocations: [], failedToolMessageIds: new Map(),
    messagePolicies: roles.map((role, i) => ({ canonicalId: `h${i + 1}`, sequence: i + 1, role,
      visibleKind: role === "user" ? "protected" : "compressible", tokenCount: 1,
      visibleId: `compressible_${String(i + 1).padStart(6, "0")}_aa`, visibleSeq: i + 1, visibleBase62: "aa" })),
    markTree: { conflicts: [], marks: [mark("parent", 1, 8, [mark("A", 2, 3, [mark("old", 2, 2)]), mark("B", 5, 6)], mode)] },
    resultGroups: [group("A", 2, 3, "Verified A summary"), group("B", 5, 6, "Verified B summary"), group("old", 2, 2, "OBSOLETE-SUMMARY")],
  };
}

function runInput(value: ProjectionState, appliedResultGroupIds?: ReadonlySet<string>) {
  return buildCompactionRunInputForMark({
    sessionId: value.sessionId, state: value, markId: "parent", model: "provider/model", timeoutMs: 1000,
    promptText: "compact prompt", deletePromptText: "delete prompt", appliedResultGroupIds,
  });
}

function render(value: ProjectionState) {
  return renderProjectionMessages({ history: value.history, messagePolicies: value.messagePolicies,
    markTree: value.markTree, resultGroupsByMarkId: new Map(value.resultGroups.map((g) => [g.markId, g])),
    failedToolMessageIds: value.failedToolMessageIds, replacementGateOpen: false }).messages;
}

test("delete sends applied summaries and uncovered user text once, with hint and original source ranges", async () => {
  const input = runInput(state());
  const request = await createCompactionInputBuilder().build(input.build);
  assert.equal(request.promptText, "delete prompt");
  assert.match(request.hint!, /compatibility/);
  assert.deepEqual(request.transcript.map((entry) => [entry.sourceStartSeq, entry.sourceEndSeq]), [[1, 1], [2, 3], [4, 4], [5, 6], [7, 7]]);
  assert.ok(request.transcript.every((entry) => entry.opaquePlaceholderSlot === undefined));
  const text = buildUserMessage(request.transcript, "delete", request.hint);
  assert.match(text, /source_range=2\.\.3/);
  assert.match(text, /summary:A:0/);
  assert.match(text, /Keep interfaces compatible/);
  assert.match(text, /Deployment is not verified/);
  assert.doesNotMatch(text, /RAW-|OBSOLETE|REMINDER-NOISE|<opaque/);
  assert.ok(text.length < 2000);
});

test("unapplied results use originals; a snapshot of displayed groups takes precedence over stale applied flags", () => {
  const value = state();
  const unapplied = { ...value, resultGroups: value.resultGroups.map((g) => ({ ...g, applied: false })) };
  assert.match(runInput(unapplied).build.transcript.map((e) => e.contentText).join("\n"), /RAW-A/);
  assert.doesNotMatch(runInput(unapplied, new Set(["A", "B"])).build.transcript.map((e) => e.contentText).join("\n"), /RAW-/);
});

test("delete rejects partial summary coverage and system messages even behind replacements", () => {
  const value = state();
  assert.throws(() => runInput({ ...value, markTree: { ...value.markTree, marks: [{ ...value.markTree.marks[0], endSequence: 2 }] } }), /fragment in full/);
  assert.throws(() => runInput({ ...value, history: { ...value.history, messages: value.history.messages.map((m) => m.sequence === 2 ? { ...m, role: "system" } : m) } }), /protected system/);
});

test("delete results are not fed recursively to another model call", () => {
  const value = state();
  assert.throws(() => runInput({ ...value, resultGroups: value.resultGroups.map((g) => g.markId === "A" ? { ...g, mode: "delete", executionMode: "delete" } : g) }), /applied delete result/);
});

test("missing independent delete prompt fails instead of using compact rules", () => {
  const value = state();
  assert.throws(() => buildCompactionRunInputForMark({ sessionId: value.sessionId, state: value, markId: "parent", model: "model", timeoutMs: 1000, promptText: "compact" }), /Missing delete prompt/);
});

test("compact preserves existing summaries exactly through opaque mapping and final projection", async () => {
  const value = state("compact");
  const input = runInput(value);
  const request = await createCompactionInputBuilder().build(input.build);
  const text = '<opaque slot="S1"/><opaque slot="S2"/><opaque slot="S3"/><opaque slot="S4"/>New gap summary';
  const validatedOutput = await createOutputValidator().validate({ request, response: { rawPayload: { plan: "preserve", compression_output: text } } });
  const result = buildCompactionResultGroup({ request, validatedOutput, runInput: input, now: () => "now" });
  assert.deepEqual(result.fragments.map((f) => [f.sourceStartSeq, f.sourceEndSeq, f.replacementText]), [
    [2, 3, "Verified A summary"], [5, 6, "Verified B summary"], [7, 8, "New gap summary"],
  ]);
  const projected = render({ ...value, resultGroups: [...value.resultGroups, { ...result, fragmentCount: result.fragments.length, payloadSha256: "new", applied: true, fragments: result.fragments.map((f, fragmentIndex) => ({ ...f, fragmentIndex })) }] });
  const output = projected.map((m) => m.contentText).join("\n");
  assert.match(output, /Verified A summary/);
  assert.match(output, /Keep interfaces compatible/);
  assert.doesNotMatch(output, /RAW-|OBSOLETE/);
});

test("failed delete leaves child projection intact; complete delete owns its original range", async () => {
  const value = state();
  const before = render(value);
  const input = runInput(value);
  const request = await createCompactionInputBuilder().build(input.build);
  await assert.rejects(createOutputValidator().validate({ request, response: { rawPayload: { plan: "bad", compression_output: "" } } }));
  assert.deepEqual(render(value), before);
  const validatedOutput = await createOutputValidator().validate({ request, response: { rawPayload: { plan: "retain effective facts", compression_output: "User requires compatible interfaces. Deployment remains unverified." } } });
  const result = buildCompactionResultGroup({ request, validatedOutput, runInput: input, now: () => "now" });
  assert.deepEqual([result.sourceStartSeq, result.sourceEndSeq], [1, 8]);
  assert.equal(result.fragments.length, 1);
  const after = render({ ...value, resultGroups: [...value.resultGroups, { ...result, fragmentCount: 1, payloadSha256: "new", applied: true, fragments: result.fragments.map((f, fragmentIndex) => ({ ...f, fragmentIndex })) }] });
  assert.equal(after.length, 1);
  assert.equal(after[0].contentText, validatedOutput.contentText);
  assert.deepEqual(render(value), before);
});
