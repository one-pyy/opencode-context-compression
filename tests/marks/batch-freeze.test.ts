import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { freezeCurrentCompactionBatch } from "../../src/marks/batch-freeze.js";
import { persistMark } from "../../src/marks/mark-service.js";
import {
  readSessionFileLock,
  releaseSessionFileLock,
} from "../../src/runtime/file-lock.js";
import {
  createSqliteSessionStateStore,
  type SqliteSessionStateStore,
} from "../../src/state/store.js";

test("freezeCurrentCompactionBatch persists the exact current mark set and later marks stay outside that frozen batch", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    store.syncCanonicalHostMessages({
      revision: "rev-batch-1",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-1", "canon-src-1", "assistant"),
        hostMessage("src-2", "canon-src-2", "tool"),
        hostMessage("src-3", "canon-src-3", "assistant"),
        hostMessage("src-4", "canon-src-4", "tool"),
        hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
        hostMessage("mark-tool-2", "canon-mark-tool-2", "tool"),
        hostMessage("mark-tool-3", "canon-mark-tool-3", "tool"),
      ],
    });

    persistMark({
      store,
      markID: "mark-1",
      toolCallMessageID: "mark-tool-1",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "src-1" }, { hostMessageID: "src-2" }],
    });
    persistMark({
      store,
      markID: "mark-2",
      toolCallMessageID: "mark-tool-2",
      allowDelete: true,
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "src-3" }, { hostMessageID: "src-4" }],
    });

    const frozen = await freezeCurrentCompactionBatch({
      store,
      lockDirectory,
      sessionID: store.sessionID,
      batchID: "batch-1",
      now: () => clock.tick(),
      note: "freeze-current-marks",
      metadata: { scheduler: "test" },
    });

    assert.equal(frozen.started, true);
    if (!frozen.started) {
      assert.fail("expected the compaction batch to start");
    }

    assert.deepEqual(frozen.runtimeBatch.memberIDs, ["mark-1", "mark-2"]);
    assert.equal(frozen.persistedBatch.canonicalRevision, "rev-batch-1");
    assert.deepEqual(frozen.persistedMembers, [
      {
        batchID: "batch-1",
        memberIndex: 0,
        markID: "mark-1",
        sourceSnapshotID: "mark-1:snapshot",
        allowDelete: false,
      },
      {
        batchID: "batch-1",
        memberIndex: 1,
        markID: "mark-2",
        sourceSnapshotID: "mark-2:snapshot",
        allowDelete: true,
      },
    ]);

    persistMark({
      store,
      markID: "mark-3",
      toolCallMessageID: "mark-tool-3",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "src-1" }],
    });

    assert.ok(store.getMark("mark-3"));
    assert.equal(frozen.runtimeBatch.has("mark-3"), false);
    assert.deepEqual(
      store.listCompactionBatchMarks("batch-1").map((member) => member.markID),
      ["mark-1", "mark-2"],
    );
    assert.deepEqual(
      store.listMarks({ status: "active" }).map((mark) => mark.markID),
      ["mark-1", "mark-2", "mark-3"],
    );

    const lockState = await readSessionFileLock({
      lockDirectory,
      sessionID: store.sessionID,
      now: () => clock.current,
    });
    assert.equal(lockState.kind, "running");
    if (lockState.kind === "running") {
      assert.equal(
        lockState.record.startedAtMs,
        frozen.runtimeBatch.frozenAtMs,
      );
      assert.equal(lockState.record.note, "freeze-current-marks");
    }

    await releaseSessionFileLock({
      lockDirectory,
      sessionID: store.sessionID,
    });
  });
});

test("freezeCurrentCompactionBatch returns no-active-marks without creating a lock when nothing is persisted yet", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    store.syncCanonicalHostMessages({
      revision: "rev-batch-empty",
      syncedAtMs: clock.tick(),
      messages: [hostMessage("src-1", "canon-src-1", "assistant")],
    });

    const frozen = await freezeCurrentCompactionBatch({
      store,
      lockDirectory,
      sessionID: store.sessionID,
      batchID: "batch-empty",
      now: () => clock.tick(),
    });

    assert.deepEqual(frozen, {
      started: false,
      reason: "no-active-marks",
    });
    assert.equal(store.getCompactionBatch("batch-empty"), undefined);

    const lockState = await readSessionFileLock({
      lockDirectory,
      sessionID: store.sessionID,
      now: () => clock.current,
    });
    assert.equal(lockState.kind, "unlocked");
  });
});

function hostMessage(
  hostMessageID: string,
  canonicalMessageID: string,
  role: string,
) {
  return {
    hostMessageID,
    canonicalMessageID,
    role,
  };
}

async function withTempEnvironment(
  run: (context: {
    store: SqliteSessionStateStore;
    clock: ReturnType<typeof createClock>;
    lockDirectory: string;
  }) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-batch-freeze-"),
  );
  const lockDirectory = join(pluginDirectory, "locks");
  const clock = createClock();
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "test-session",
    now: () => clock.current,
  });

  try {
    await run({ store, clock, lockDirectory });
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
