import assert from "node:assert/strict";
import test from "node:test";

import { buildStableVisibleId } from "../../../src/identity/visible-sequence.js";
import { createCompressionMarkTokenCounter } from "../../../src/projection/compression-mark-tokens.js";
import { buildProjectedReferableMarkers } from "../../../src/projection/referable-markers.js";
import type { ProjectedMessageSet } from "../../../src/projection/types.js";
import { createProjectionBackedMessagesTransformProjector } from "../../../src/runtime/messages-transform.js";
import { createContextCompressionHooks } from "../../../src/runtime/plugin-hooks.js";
import type { CompleteResultGroup } from "../../../src/state/result-group-repository.js";

function projection(sessionId = "mark-tokens", multiplier = 1): ProjectedMessageSet {
  const messagePolicies = [
    { role: "system" as const, visibleKind: "protected" as const, tokenCount: 0, visibleTokenCount: 100 },
    { role: "assistant" as const, visibleKind: "compressible" as const, tokenCount: 13, visibleTokenCount: 23 },
    { role: "user" as const, visibleKind: "protected" as const, tokenCount: 0, visibleTokenCount: 7 },
    { role: "assistant" as const, visibleKind: "compressible" as const, tokenCount: 29, visibleTokenCount: 39 },
    { role: "assistant" as const, visibleKind: "compressible" as const, tokenCount: 41, visibleTokenCount: 51 },
  ].map((entry, index) => ({
    ...entry,
    tokenCount: entry.tokenCount * multiplier,
    sequence: 100 + index * 10,
    canonicalId: `${sessionId}-${index}`,
    visibleSeq: index + 1,
    visibleBase62: "a1",
    visibleId: buildStableVisibleId(entry.visibleKind, index + 1, `${sessionId}-${index}`),
  }));
  return {
    sessionId,
    messages: messagePolicies.map((policy) => ({
      ...policy, source: "canonical", contentText: "Visible text.",
    })),
    toolResultOverrides: [], reminders: [], conflicts: [],
    state: {
      sessionId,
      history: { sessionId, messages: [], marks: [], compressionMarkToolCalls: [] },
      markTree: { marks: [], conflicts: [] }, conflicts: [], messagePolicies,
      visibleIdAllocations: [], resultGroups: [], failedToolMessageIds: new Map(),
    },
  };
}

test("mark tokens count inclusive ranges, preserve protected originals and exclude system", () => {
  const input = projection();
  const ids = input.state.messagePolicies.map((policy) => policy.visibleId);
  const count = createCompressionMarkTokenCounter(input);
  assert.equal(count({ mode: "compact", from: ids[1], to: ids[3] }), 42);
  assert.equal(count({ mode: "delete", from: ids[1], to: ids[3] }), 69);
  assert.equal(count({ mode: "delete", from: ids[3], to: ids[3] }), 39);
  assert.equal(count({ mode: "compact", from: ids[2], to: ids[2] }), 0);
  assert.equal(count({ mode: "delete", from: ids[2], to: ids[2] }), 7);
  assert.equal(count({ mode: "delete", from: ids[0], to: ids[0] }), 0);
  assert.equal(count({ mode: "compact", from: ids[1].replace("compressible_", ""), to: ids[3] }), 42);
  assert.equal(count({ mode: "compact", from: ids[3], to: ids[1] }), undefined);
  assert.equal(count({ mode: "compact", from: "invalid", to: ids[3] }), undefined);
  assert.equal(count({ mode: "compact", from: buildStableVisibleId("compressible", 20, "unknown"), to: ids[3] }), undefined);
});

test("mark tokens count visible summaries without hidden sources and require complete fragments", () => {
  const input = projection();
  const policies = input.state.messagePolicies;
  const fragment = { fragmentIndex: 0, sourceStartSeq: policies[1].sequence, sourceEndSeq: policies[3].sequence, replacementText: "Summary." };
  const group: CompleteResultGroup = {
    markId: "earlier", mode: "compact", sourceStartSeq: fragment.sourceStartSeq, sourceEndSeq: fragment.sourceEndSeq,
    fragmentCount: 1, executionMode: "compact", createdAt: "t", payloadSha256: "test", applied: true, fragments: [fragment],
  };
  const markers = buildProjectedReferableMarkers(group, fragment, (sequence) => policies.find((policy) => policy.sequence === sequence)?.visibleId)!;
  const summarized: ProjectedMessageSet = {
    ...input,
    messages: [
      input.messages[0],
      { source: "result-group", role: "assistant", visibleKind: "referable", visibleId: markers.startId, sourceMarkId: group.markId, contentText: "Summary.", visibleTokenCount: 5 },
      input.messages[2], input.messages[4],
    ],
    state: { ...input.state, resultGroups: [group] },
  };
  const count = createCompressionMarkTokenCounter(summarized);
  assert.equal(count({ mode: "compact", from: markers.startId, to: policies[4].visibleId }), 41);
  assert.equal(count({ mode: "delete", from: markers.startId, to: markers.endId }), 12);
  assert.equal(count({ mode: "delete", from: policies[1].visibleId, to: policies[4].visibleId }), 63);
  assert.equal(count({ mode: "delete", from: policies[2].visibleId, to: policies[4].visibleId }), undefined);
  assert.equal(count({ mode: "delete", from: markers.startId.replace(/.$/u, "!"), to: markers.endId }), undefined);
  const pending = createCompressionMarkTokenCounter({ ...input, state: { ...input.state, resultGroups: [{ ...group, applied: false }] } });
  assert.equal(pending({ mode: "compact", from: policies[1].visibleId, to: policies[3].visibleId }), 42);
  assert.equal(pending({ mode: "delete", from: markers.startId, to: markers.endId }), undefined);
});

test("mark tokens reuse existing counts and report missing counts without estimating", () => {
  const input = projection();
  const ids = input.state.messagePolicies.map((policy) => policy.visibleId);
  const count = createCompressionMarkTokenCounter({
    ...input,
    messages: input.messages.map((message, index) => index === 3
      ? { ...message, contentText: "X".repeat(10000), visibleTokenCount: undefined }
      : message),
  });
  assert.equal(count({ mode: "compact", from: ids[1], to: ids[3] }), 42);
  assert.equal(count({ mode: "delete", from: ids[1], to: ids[3] }), undefined);
  assert.equal(count({ mode: "delete", from: ids[1], to: ids[1] }), 23);
  const zero = createCompressionMarkTokenCounter({
    ...input,
    messages: input.messages.map((message) => ({ ...message, contentText: "X".repeat(10000), visibleTokenCount: 0 })),
  });
  assert.equal(zero({ mode: "delete", from: ids[1], to: ids[3] }), 0);
});

test("runtime mark results use session-isolated snapshots and refresh on the next projection", async () => {
  let current = projection("session-a");
  const projector = createProjectionBackedMessagesTransformProjector({ buildProjection: () => current });
  const hooks = createContextCompressionHooks({ messagesTransformProjector: projector });
  const first = current;
  const args = { mode: "compact" as const, from: first.state.messagePolicies[1].visibleId, to: first.state.messagePolicies[3].visibleId };
  const context = (sessionID: string) => ({ sessionID, messageID: "mark-message", agent: "build", directory: "/tmp/opencode", worktree: "/tmp/opencode", abort: new AbortController().signal, metadata() {}, ask: async () => {} });
  await projector.project({ input: {}, currentMessages: [], replacementGateOpen: false });
  current = projection("session-b", 10);
  await projector.project({ input: {}, currentMessages: [], replacementGateOpen: false });
  const resultA = JSON.parse(await hooks.tool!.compression_mark.execute(args, context(first.sessionId)));
  assert.equal(resultA.ok, true);
  assert.equal(resultA.tokenCount, 42);
  const secondArgs = { mode: "compact" as const, from: current.state.messagePolicies[1].visibleId, to: current.state.messagePolicies[3].visibleId };
  assert.equal(JSON.parse(await hooks.tool!.compression_mark.execute(secondArgs, context(current.sessionId))).tokenCount, 420);
  assert.equal(JSON.parse(await hooks.tool!.compression_mark.execute(args, context("unseen-session"))).tokenCount, null);
  current = projection("session-a", 2);
  await projector.project({ input: {}, currentMessages: [], replacementGateOpen: false });
  assert.equal(JSON.parse(await hooks.tool!.compression_mark.execute(args, context(first.sessionId))).tokenCount, 84);
});
