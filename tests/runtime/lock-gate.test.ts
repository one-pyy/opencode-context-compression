import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireSessionFileLock,
  readSessionFileLock,
  releaseSessionFileLock,
  resolveSessionFileLockPath,
  settleSessionFileLock,
  waitForSessionFileLock,
} from "../../src/runtime/file-lock.js";
import { evaluateLockGate, startFrozenCompactionBatch } from "../../src/runtime/lock-gate.js";

test("ordinary chat waits while DCP mark and non-DCP tools remain allowed, then resumes on success", async () => {
  await withTempLockDirectory(async (lockDirectory) => {
    const acquired = await acquireSessionFileLock({
      lockDirectory,
      sessionID: "session-success",
    });
    assert.equal(acquired.acquired, true);

    const ordinaryChat = await evaluateLockGate({
      lockDirectory,
      sessionID: "session-success",
      target: { kind: "ordinary-chat" },
      pollIntervalMs: 1,
    });
    assert.equal(ordinaryChat.path, "ordinary-chat");
    assert.equal(ordinaryChat.action, "wait");
    assert.equal(ordinaryChat.reason, "active-compaction-lock");

    const dcpMarkTool = await evaluateLockGate({
      lockDirectory,
      sessionID: "session-success",
      target: {
        kind: "tool",
        toolName: "dcp_mark",
        dcpMarkToolName: "dcp_mark",
      },
    });
    assert.deepEqual(
      {
        path: dcpMarkTool.path,
        action: dcpMarkTool.action,
        reason: dcpMarkTool.reason,
      },
      {
        path: "dcp-mark-tool",
        action: "allow",
        reason: "dcp-mark-tool-bypasses-active-lock",
      },
    );

    const nonDcpTool = await evaluateLockGate({
      lockDirectory,
      sessionID: "session-success",
      target: {
        kind: "tool",
        toolName: "read",
        dcpMarkToolName: "dcp_mark",
      },
    });
    assert.deepEqual(
      {
        path: nonDcpTool.path,
        action: nonDcpTool.action,
        reason: nonDcpTool.reason,
      },
      {
        path: "non-dcp-tool",
        action: "allow",
        reason: "non-dcp-tool-bypasses-lock",
      },
    );

    const settle = delay(5).then(async () => {
      await settleSessionFileLock({
        lockDirectory,
        sessionID: "session-success",
        status: "succeeded",
      });
    });

    const waitOutcome = await ordinaryChat.wait();
    await settle;

    assert.equal(waitOutcome.outcome, "succeeded");

    await releaseSessionFileLock({
      lockDirectory,
      sessionID: "session-success",
    });
  });
});

test("ordinary chat wait exits immediately on terminal failure", async () => {
  await withTempLockDirectory(async (lockDirectory) => {
    await acquireSessionFileLock({
      lockDirectory,
      sessionID: "session-failure",
    });

    const ordinaryChat = await evaluateLockGate({
      lockDirectory,
      sessionID: "session-failure",
      target: { kind: "ordinary-chat" },
      pollIntervalMs: 1,
    });
    assert.equal(ordinaryChat.action, "wait");

    const settle = delay(5).then(async () => {
      await settleSessionFileLock({
        lockDirectory,
        sessionID: "session-failure",
        status: "failed",
        note: "transport-execution-failed",
      });
    });

    const waitOutcome = await ordinaryChat.wait();
    await settle;

    assert.equal(waitOutcome.outcome, "failed");
    if (waitOutcome.outcome === "failed") {
      assert.equal(waitOutcome.finalState.record.note, "transport-execution-failed");
    }

    await releaseSessionFileLock({
      lockDirectory,
      sessionID: "session-failure",
    });
  });
});

test("stale locks are ignored after timeout instead of blocking ordinary chat", async () => {
  await withTempLockDirectory(async (lockDirectory) => {
    await acquireSessionFileLock({
      lockDirectory,
      sessionID: "session-timeout",
      startedAtMs: 0,
      now: () => 0,
    });

    const state = await readSessionFileLock({
      lockDirectory,
      sessionID: "session-timeout",
      timeoutMs: 100,
      now: () => 250,
    });
    assert.equal(state.kind, "stale");

    const ordinaryChat = await evaluateLockGate({
      lockDirectory,
      sessionID: "session-timeout",
      target: { kind: "ordinary-chat" },
      timeoutMs: 100,
      now: () => 250,
    });
    assert.deepEqual(
      {
        action: ordinaryChat.action,
        reason: ordinaryChat.reason,
      },
      {
        action: "allow",
        reason: "stale-lock-ignored",
      },
    );

    const waitOutcome = await waitForSessionFileLock({
      lockDirectory,
      sessionID: "session-timeout",
      timeoutMs: 100,
      now: () => 250,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(waitOutcome.outcome, "timed-out");
  });
});

test("manual lock-file removal wakes ordinary chat without masquerading as success", async () => {
  await withTempLockDirectory(async (lockDirectory) => {
    await acquireSessionFileLock({
      lockDirectory,
      sessionID: "session-manual-clear",
    });

    const ordinaryChat = await evaluateLockGate({
      lockDirectory,
      sessionID: "session-manual-clear",
      target: { kind: "ordinary-chat" },
      pollIntervalMs: 1,
    });
    assert.equal(ordinaryChat.action, "wait");

    const release = delay(5).then(async () => {
      await releaseSessionFileLock({
        lockDirectory,
        sessionID: "session-manual-clear",
      });
    });

    const waitOutcome = await ordinaryChat.wait();
    await release;

    assert.equal(waitOutcome.outcome, "manually-cleared");
    if (waitOutcome.outcome === "manually-cleared") {
      assert.equal(waitOutcome.lastObservedLock.status, "running");
    }
  });
});

test("readSessionFileLock tolerates a transient partial lock rewrite but still returns the final record", async () => {
  await withTempLockDirectory(async (lockDirectory) => {
    const sessionID = "session-partial-rewrite";
    const lockPath = resolveSessionFileLockPath(lockDirectory, sessionID);

    await writeFile(lockPath, '{\n  "version": 1,\n  "sessionID": "session-partial-rewrite",\n', "utf8");

    const publishFinalRecord = delay(1).then(async () => {
      await writeFile(
        lockPath,
        `${JSON.stringify(
          {
            version: 1,
            sessionID,
            status: "failed",
            startedAtMs: 10,
            updatedAtMs: 20,
            settledAtMs: 20,
            note: "transport-execution-failed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    });

    const state = await readSessionFileLock({
      lockDirectory,
      sessionID,
      now: () => 20,
    });
    await publishFinalRecord;

    assert.equal(state.kind, "failed");
    if (state.kind === "failed") {
      assert.equal(state.record.note, "transport-execution-failed");
      assert.equal(state.record.settledAtMs, 20);
    }
  });
});

test("frozen batch membership stays fixed even when later marks are persisted", async () => {
  await withTempLockDirectory(async (lockDirectory) => {
    const persistedMarks = [{ id: "mark-1" }, { id: "mark-2" }];
    const started = await startFrozenCompactionBatch({
      lockDirectory,
      sessionID: "session-batch",
      marks: persistedMarks,
      identifyMark: (mark) => mark.id,
      now: () => 1_000,
    });

    assert.equal(started.started, true);
    if (!started.started) {
      assert.fail("expected the batch to start");
    }

    assert.deepEqual(started.batch.memberIDs, ["mark-1", "mark-2"]);
    assert.equal(started.batch.size, 2);

    persistedMarks.push({ id: "mark-3" });
    assert.deepEqual(
      persistedMarks.map((mark) => mark.id),
      ["mark-1", "mark-2", "mark-3"],
    );
    assert.equal(started.batch.has("mark-3"), false);
    assert.deepEqual(started.batch.memberIDs, ["mark-1", "mark-2"]);

    const lockState = await readSessionFileLock({
      lockDirectory,
      sessionID: "session-batch",
      now: () => 1_000,
    });
    assert.equal(lockState.kind, "running");
    if (lockState.kind === "running") {
      assert.equal(lockState.record.startedAtMs, started.batch.frozenAtMs);
    }

    await releaseSessionFileLock({
      lockDirectory,
      sessionID: "session-batch",
    });
  });
});

async function withTempLockDirectory(run: (lockDirectory: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "opencode-context-compression-lock-gate-"));
  const lockDirectory = join(root, "locks");

  try {
    await mkdir(lockDirectory, { recursive: true });
    await run(lockDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
