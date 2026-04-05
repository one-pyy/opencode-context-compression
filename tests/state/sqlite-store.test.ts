import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteSessionStateStore, type SqliteSessionStateStore } from "../../src/state/store.js";

test("store syncs canonical messages and keeps visible sequence allocation permanent across removals", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-1",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("host-1", "canon-1", "user"),
        hostMessage("host-2", "canon-2", "assistant"),
      ],
    });

    const seq1 = store.ensureVisibleSequenceAssignment({
      hostMessageID: "host-1",
      visibleChecksum: "aa11",
    });
    const seq2 = store.ensureVisibleSequenceAssignment({
      hostMessageID: "host-2",
      visibleChecksum: "bb22",
    });

    assert.deepEqual(
      [seq1, seq2].map((item) => item.visibleSeq),
      [1, 2],
    );

    store.syncCanonicalHostMessages({
      revision: "rev-2",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("host-2", "canon-2", "assistant"),
        hostMessage("host-3", "canon-3", "tool"),
      ],
    });

    const seq3 = store.ensureVisibleSequenceAssignment({
      hostMessageID: "host-3",
      visibleChecksum: "cc33",
    });

    assert.equal(seq3.visibleSeq, 3);
    assert.equal(store.getHostMessage("host-1")?.canonicalPresent, false);
    assert.equal(store.getHostMessage("host-2")?.canonicalPresent, true);
    assert.equal(store.getHostMessage("host-2")?.visibleSeq, 2);
    assert.equal(store.getHostMessage("host-3")?.visibleSeq, 3);
    assert.deepEqual(store.getSessionState(), {
      lastCanonicalRevision: "rev-2",
      lastSyncedAtMs: 2,
      updatedAtMs: 2,
    });
  });
});

test("store persists mark snapshots, frozen batch membership, job attempts, and replacement linkage from the batch snapshot", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-batch",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-1", "canon-src-1", "assistant"),
        hostMessage("src-2", "canon-src-2", "tool"),
        hostMessage("src-3", "canon-src-3", "tool"),
        hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
        hostMessage("src-4", "canon-src-4", "assistant"),
        hostMessage("mark-tool-2", "canon-mark-tool-2", "tool"),
      ],
    });

    const mark1 = store.createMark({
      markID: "mark-1",
      toolCallMessageID: "mark-tool-1",
      allowDelete: false,
      markLabel: "a~c",
      createdAtMs: clock.tick(),
      sourceSnapshot: {
        messages: [
          { hostMessageID: "src-1", role: "assistant" },
          { hostMessageID: "src-2", role: "tool" },
          { hostMessageID: "src-3", role: "tool" },
        ],
      },
    });

    const batch = store.createCompactionBatch({
      batchID: "batch-1",
      canonicalRevision: "rev-batch",
      frozenAtMs: clock.tick(),
      markIDs: [mark1.markID],
    });

    store.createMark({
      markID: "mark-2",
      toolCallMessageID: "mark-tool-2",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceSnapshot: {
        messages: [
          { hostMessageID: "src-4", role: "assistant" },
          { hostMessageID: "src-2", role: "tool" },
        ],
      },
    });

    assert.deepEqual(store.listCompactionBatchMarks(batch.batchID), [
      {
        batchID: "batch-1",
        memberIndex: 0,
        markID: "mark-1",
        sourceSnapshotID: mark1.sourceSnapshotID,
        allowDelete: false,
      },
    ]);

    const job = store.createCompactionJob({
      jobID: "job-1",
      batchID: batch.batchID,
      markID: mark1.markID,
      queuedAtMs: clock.tick(),
      status: "running",
      startedAtMs: clock.current,
    });
    store.appendCompactionJobAttempt({
      jobID: job.jobID,
      attemptIndex: 0,
      modelIndex: 0,
      modelName: "gpt-5.4-mini",
      status: "running",
      startedAtMs: clock.tick(),
    });
    const replacement = store.commitReplacement({
      replacementID: "replacement-1",
      allowDelete: false,
      executionMode: "compact",
      jobID: job.jobID,
      committedAtMs: clock.tick(),
      contentText: "compacted summary",
    });
    store.appendCompactionJobAttempt({
      jobID: job.jobID,
      attemptIndex: 1,
      modelIndex: 0,
      modelName: "gpt-5.4-mini",
      status: "succeeded",
      startedAtMs: clock.tick(),
      finishedAtMs: clock.current,
      replacementID: replacement.replacementID,
    });
    store.updateCompactionJobStatus({
      jobID: job.jobID,
      status: "succeeded",
      finishedAtMs: clock.tick(),
    });
    store.updateCompactionBatchStatus({
      batchID: batch.batchID,
      status: "succeeded",
      metadata: { settled: true },
    });

    assert.equal(store.getMark(mark1.markID)?.status, "consumed");
    assert.deepEqual(
      store.listMarkSourceMessages(mark1.markID).map((message) => ({
        hostMessageID: message.hostMessageID,
        canonicalMessageID: message.canonicalMessageID,
      })),
      [
        { hostMessageID: "src-1", canonicalMessageID: "canon-src-1" },
        { hostMessageID: "src-2", canonicalMessageID: "canon-src-2" },
        { hostMessageID: "src-3", canonicalMessageID: "canon-src-3" },
      ],
    );
    assert.deepEqual(store.listReplacementMarkLinks(replacement.replacementID), [
      {
        replacementID: replacement.replacementID,
        markID: mark1.markID,
        linkKind: "consumed",
        createdAtMs: replacement.committedAtMs,
      },
    ]);
    assert.deepEqual(
      store.listReplacementSourceMessages(replacement.replacementID).map((message) => message.hostMessageID),
      ["src-1", "src-2", "src-3"],
    );
    assert.equal(
      store.findLatestCommittedReplacementForMark(mark1.markID)?.replacementID,
      replacement.replacementID,
    );
    assert.equal(store.getCompactionBatch(batch.batchID)?.status, "succeeded");
    assert.equal(store.getCompactionJob(job.jobID)?.status, "succeeded");
    assert.deepEqual(
      store.listCompactionJobAttempts(job.jobID).map((attempt) => ({
        attemptIndex: attempt.attemptIndex,
        status: attempt.status,
        replacementID: attempt.replacementID,
      })),
      [
        { attemptIndex: 0, status: "running", replacementID: undefined },
        { attemptIndex: 1, status: "succeeded", replacementID: replacement.replacementID },
      ],
    );
  });
});

test("store uses latest linked replacement match, supports delete invalidation, and records advisory lock audit state", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-delete",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-a", "canon-a", "assistant"),
        hostMessage("src-b", "canon-b", "tool"),
        hostMessage("mark-tool-a", "canon-mark-tool-a", "tool"),
        hostMessage("mark-tool-delete", "canon-mark-tool-delete", "tool"),
      ],
    });

    const mark = store.createMark({
      markID: "mark-a",
      toolCallMessageID: "mark-tool-a",
      allowDelete: true,
      createdAtMs: clock.tick(),
      sourceSnapshot: {
        messages: [
          { hostMessageID: "src-a", role: "assistant" },
          { hostMessageID: "src-b", role: "tool" },
        ],
      },
    });

    const batch = store.createCompactionBatch({
      batchID: "batch-delete",
      frozenAtMs: clock.tick(),
      markIDs: [mark.markID],
    });

    const job1 = store.createCompactionJob({
      jobID: "job-delete-1",
      batchID: batch.batchID,
      markID: mark.markID,
      queuedAtMs: clock.tick(),
    });
    const firstReplacement = store.commitReplacement({
      replacementID: "replacement-first",
      allowDelete: true,
      executionMode: "delete",
      jobID: job1.jobID,
      committedAtMs: clock.tick(),
      contentText: "delete notice one",
    });

    const job2 = store.createCompactionJob({
      jobID: "job-delete-2",
      batchID: batch.batchID,
      markID: mark.markID,
      queuedAtMs: clock.tick(),
    });
    const secondReplacement = store.commitReplacement({
      replacementID: "replacement-second",
      allowDelete: true,
      executionMode: "delete",
      jobID: job2.jobID,
      committedAtMs: clock.tick(),
      contentText: "delete notice two",
    });

    assert.equal(
      store.findLatestCommittedReplacementForMark(mark.markID)?.replacementID,
      secondReplacement.replacementID,
    );

    const deleteMark = store.createMark({
      markID: "mark-delete",
      toolCallMessageID: "mark-tool-delete",
      allowDelete: true,
      createdAtMs: clock.tick(),
      sourceSnapshot: {
        messages: [
          { hostMessageID: "src-a", role: "assistant" },
          { hostMessageID: "src-b", role: "tool" },
        ],
      },
    });

    const invalidated = store.invalidateReplacement({
      replacementID: firstReplacement.replacementID,
      invalidatedAtMs: clock.tick(),
      invalidationKind: "execution-delete",
      invalidatedByMarkID: deleteMark.markID,
    });
    const latestGate = store.recordRuntimeGateObservation({
      observationID: "gate-1",
      observedState: "running",
      observedAtMs: clock.tick(),
      startedAtMs: 123,
      activeJobCount: 2,
      note: "file-lock-observed",
      metadata: { source: "audit-only" },
    });

    assert.equal(invalidated.status, "invalidated");
    assert.equal(invalidated.invalidationKind, "execution-delete");
    assert.equal(invalidated.invalidatedByMarkID, deleteMark.markID);
    assert.equal(
      store.findLatestCommittedReplacementForMark(mark.markID)?.replacementID,
      secondReplacement.replacementID,
    );
    assert.deepEqual(store.listMarks({ status: "active" }).map((item) => item.markID), ["mark-delete"]);
    assert.deepEqual(store.getLatestRuntimeGateObservation(), latestGate);
  });
});

test("store resolves a result group from any linked mark id, not only the primary mark", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-linked-group",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-a", "canon-a", "assistant"),
        hostMessage("src-b", "canon-b", "tool"),
        hostMessage("mark-tool-a", "canon-mark-tool-a", "tool"),
        hostMessage("mark-tool-b", "canon-mark-tool-b", "tool"),
      ],
    });

    const primaryMark = store.createMark({
      markID: "mark-a",
      toolCallMessageID: "mark-tool-a",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceSnapshot: {
        messages: [
          { hostMessageID: "src-a", role: "assistant" },
          { hostMessageID: "src-b", role: "tool" },
        ],
      },
    });
    const linkedMark = store.createMark({
      markID: "mark-b",
      toolCallMessageID: "mark-tool-b",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceSnapshot: {
        messages: [
          { hostMessageID: "src-a", role: "assistant" },
          { hostMessageID: "src-b", role: "tool" },
        ],
      },
    });

    store.commitReplacement({
      replacementID: "replacement-linked",
      allowDelete: false,
      executionMode: "compact",
      committedAtMs: clock.tick(),
      markIDs: [primaryMark.markID, linkedMark.markID],
      sourceSnapshot: {
        messages: [
          { hostMessageID: "src-a", role: "assistant" },
          { hostMessageID: "src-b", role: "tool" },
        ],
      },
      contentText: "linked summary",
    });

    assert.equal(store.getReplacementResultGroup(primaryMark.markID)?.resultGroupID, "replacement-linked");
    assert.equal(store.getReplacementResultGroup(linkedMark.markID)?.resultGroupID, "replacement-linked");
    assert.deepEqual(
      store.listReplacementResultGroupMarkLinks(linkedMark.markID).map((link) => [link.markID, link.linkKind]),
      [
        ["mark-a", "primary"],
        ["mark-b", "consumed"],
      ],
    );
    assert.equal(store.findLatestCommittedReplacementForMark(linkedMark.markID)?.replacementID, "replacement-linked");
  });
});

function hostMessage(hostMessageID: string, canonicalMessageID: string, role: string) {
  return {
    hostMessageID,
    canonicalMessageID,
    role,
  };
}

async function withTempStore(
  run: (store: SqliteSessionStateStore, clock: ReturnType<typeof createClock>) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(join(tmpdir(), "opencode-context-compression-store-"));
  const clock = createClock();
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "test-session",
    now: () => clock.current,
  });

  try {
    await run(store, clock);
  } finally {
    store.close();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}

function createClock() {
  let current = 0;

  return {
    get current() {
      return current;
    },
    tick() {
      current += 1;
      return current;
    },
  };
}
