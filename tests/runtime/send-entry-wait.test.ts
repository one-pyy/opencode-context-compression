import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { freezeCurrentCompactionBatch } from "../../src/marks/batch-freeze.js";
import { persistMark } from "../../src/marks/mark-service.js";
import {
  acquireSessionFileLock,
  releaseSessionFileLock,
} from "../../src/runtime/file-lock.js";
import {
  ActiveCompactionLockError,
  guardToolExecutionDuringLock,
  waitForOrdinaryChatGateIfNeeded,
} from "../../src/runtime/send-entry-gate.js";
import {
  createSqliteSessionStateStore,
  type SqliteSessionStateStore,
} from "../../src/state/store.js";

test("ordinary chat waits at send-entry while unrelated tools still run and resumes when the active batch succeeds", async () => {
  await withTempEnvironment(
    async ({ pluginDirectory, lockDirectory, store }) => {
      seedMarkSet(store, ["mark-1", "mark-2"]);
      const frozen = await freezeCurrentCompactionBatch({
        store,
        lockDirectory,
        sessionID: store.sessionID,
        batchID: "batch-success",
      });
      assert.equal(frozen.started, true);
      if (!frozen.started) {
        assert.fail("expected the compaction batch to start");
      }

      store.updateCompactionBatchStatus({
        batchID: frozen.persistedBatch.batchID,
        status: "running",
      });

      let settled = false;
      const waitPromise = waitForOrdinaryChatGateIfNeeded({
        pluginDirectory,
        sessionID: store.sessionID,
        pollIntervalMs: 1,
      }).finally(() => {
        settled = true;
      });

      await delay(5);
      assert.equal(settled, false);

      await guardToolExecutionDuringLock({
        pluginDirectory,
        sessionID: store.sessionID,
        toolName: "read",
        markToolNames: ["compression_mark"],
        blockedInternalToolNames: ["compression_run_internal"],
      });

      const release = delay(10).then(async () => {
        store.updateCompactionBatchStatus({
          batchID: frozen.persistedBatch.batchID,
          status: "succeeded",
        });
        await releaseSessionFileLock({
          lockDirectory,
          sessionID: store.sessionID,
        });
      });

      const outcome = await waitPromise;
      await release;

      assert.deepEqual(outcome, {
        outcome: "succeeded",
        source: "compaction-batch",
      });
    },
  );
});

test("ordinary chat stops waiting once the active batch reaches terminal failure", async () => {
  await withTempEnvironment(
    async ({ pluginDirectory, lockDirectory, store }) => {
      seedMarkSet(store, ["mark-1"]);
      const frozen = await freezeCurrentCompactionBatch({
        store,
        lockDirectory,
        sessionID: store.sessionID,
        batchID: "batch-failure",
      });
      assert.equal(frozen.started, true);
      if (!frozen.started) {
        assert.fail("expected the compaction batch to start");
      }

      store.updateCompactionBatchStatus({
        batchID: frozen.persistedBatch.batchID,
        status: "running",
      });

      const release = delay(10).then(async () => {
        store.updateCompactionBatchStatus({
          batchID: frozen.persistedBatch.batchID,
          status: "failed",
        });
        await releaseSessionFileLock({
          lockDirectory,
          sessionID: store.sessionID,
        });
      });

      const outcome = await waitForOrdinaryChatGateIfNeeded({
        pluginDirectory,
        sessionID: store.sessionID,
        pollIntervalMs: 1,
      });
      await release;

      assert.deepEqual(outcome, {
        outcome: "failed",
        source: "compaction-batch",
      });
    },
  );
});

test("ordinary chat treats an unlocked but still-running batch as a manual clear instead of a synthetic success", async () => {
  await withTempEnvironment(
    async ({ pluginDirectory, lockDirectory, store }) => {
      seedMarkSet(store, ["mark-1"]);
      const frozen = await freezeCurrentCompactionBatch({
        store,
        lockDirectory,
        sessionID: store.sessionID,
        batchID: "batch-manual-clear",
      });
      assert.equal(frozen.started, true);
      if (!frozen.started) {
        assert.fail("expected the compaction batch to start");
      }

      store.updateCompactionBatchStatus({
        batchID: frozen.persistedBatch.batchID,
        status: "running",
      });

      const clear = delay(10).then(async () => {
        await releaseSessionFileLock({
          lockDirectory,
          sessionID: store.sessionID,
        });
      });

      const outcome = await waitForOrdinaryChatGateIfNeeded({
        pluginDirectory,
        sessionID: store.sessionID,
        pollIntervalMs: 1,
      });
      await clear;

      assert.equal(outcome?.outcome, "manually-cleared");
      if (outcome?.outcome === "manually-cleared") {
        assert.equal(outcome.batchStatus, "running");
        assert.equal(outcome.lastObservedLock.status, "running");
      }
    },
  );
});

test("ordinary chat stops waiting when the live lock ages past the configured timeout", async () => {
  await withTempEnvironment(
    async ({ pluginDirectory, lockDirectory, store }) => {
      await acquireSessionFileLock({
        lockDirectory,
        sessionID: store.sessionID,
        startedAtMs: 0,
        now: () => 0,
      });

      const outcome = await waitForOrdinaryChatGateIfNeeded({
        pluginDirectory,
        sessionID: store.sessionID,
        now: () => 250,
        timeoutMs: 100,
        pollIntervalMs: 0,
        sleep: async () => {},
      });

      assert.deepEqual(outcome, {
        outcome: "timed-out",
        source: "lock-file",
      });
    },
  );
});

test("compression_mark remains allowed during lock while blocked internal execution stays out and late marks do not mutate the frozen batch", async () => {
  await withTempEnvironment(
    async ({ pluginDirectory, lockDirectory, store }) => {
      seedMarkSet(store, ["mark-1", "mark-2"]);
      const frozen = await freezeCurrentCompactionBatch({
        store,
        lockDirectory,
        sessionID: store.sessionID,
        batchID: "batch-mark-bypass",
      });
      assert.equal(frozen.started, true);
      if (!frozen.started) {
        assert.fail("expected the compaction batch to start");
      }

      store.updateCompactionBatchStatus({
        batchID: frozen.persistedBatch.batchID,
        status: "running",
      });

      await guardToolExecutionDuringLock({
        pluginDirectory,
        sessionID: store.sessionID,
        toolName: "compression_mark",
        markToolNames: ["compression_mark"],
        blockedInternalToolNames: ["compression_run_internal"],
      });

      await assert.rejects(
        () =>
          guardToolExecutionDuringLock({
            pluginDirectory,
            sessionID: store.sessionID,
            toolName: "compression_run_internal",
            markToolNames: ["compression_mark"],
            blockedInternalToolNames: ["compression_run_internal"],
          }),
        (error: unknown) =>
          error instanceof ActiveCompactionLockError &&
          error.toolName === "compression_run_internal",
      );

      persistMark({
        store,
        markID: "mark-3",
        toolCallMessageID: "mark-tool-3",
        route: "keep",
        sourceMessages: [{ hostMessageID: "src-1" }],
      });

      assert.deepEqual(
        store
          .listCompactionBatchMarks(frozen.persistedBatch.batchID)
          .map((member) => member.markID),
        ["mark-1", "mark-2"],
      );
      assert.deepEqual(
        store.listMarks({ status: "active" }).map((mark) => mark.markID),
        ["mark-1", "mark-2", "mark-3"],
      );

      await releaseSessionFileLock({
        lockDirectory,
        sessionID: store.sessionID,
      });
    },
  );
});

function seedMarkSet(
  store: SqliteSessionStateStore,
  markIDs: readonly string[],
): void {
  store.syncCanonicalHostMessages({
    revision: "rev-send-entry",
    messages: [
      hostMessage("src-1", "canon-src-1", "assistant"),
      hostMessage("src-2", "canon-src-2", "tool"),
      hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
      hostMessage("mark-tool-2", "canon-mark-tool-2", "tool"),
      hostMessage("mark-tool-3", "canon-mark-tool-3", "tool"),
    ],
  });

  markIDs.forEach((markID, index) => {
    persistMark({
      store,
      markID,
      toolCallMessageID: `mark-tool-${index + 1}`,
      route: "keep",
      sourceMessages:
        index % 2 === 0
          ? [{ hostMessageID: "src-1" }]
          : [{ hostMessageID: "src-2" }],
    });
  });
}

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
    pluginDirectory: string;
    lockDirectory: string;
    store: SqliteSessionStateStore;
  }) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-send-entry-"),
  );
  const lockDirectory = join(pluginDirectory, "locks");
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "test-session",
  });

  try {
    await run({ pluginDirectory, lockDirectory, store });
  } finally {
    store.close();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
