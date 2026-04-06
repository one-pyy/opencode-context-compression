import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireSessionFileLock,
  releaseSessionFileLock,
  settleSessionFileLock,
} from "../../../src/runtime/file-lock.js";
import { createFileLockBackedSendEntryGate } from "../../../src/runtime/send-entry-gate.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "ordinary chat waits for an active lock and resumes when compaction settles or the lock is cleared",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "send entry gate",
    });
    const lockRoot = await mkdtemp(join(tmpdir(), "send-entry-gate-"));
    const lockDirectory = join(lockRoot, "locks");
    const gate = createFileLockBackedSendEntryGate({
      lockDirectory,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    const startedAtMs = Date.now();

    const acquired = await acquireSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      startedAtMs,
      now: () => startedAtMs,
    });
    assert.equal(acquired.acquired, true);

    const waitingForSuccess = gate.waitIfNeeded(fixture.sessionID);
    await delay(20);
    await settleSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      status: "succeeded",
      settledAtMs: Date.now(),
      now: Date.now,
    });

    await assert.doesNotReject(() => waitingForSuccess);
    assert.deepEqual(await waitingForSuccess, {
      waited: true,
      releasedBy: "lock-succeeded",
      reason: "active compaction lock settled successfully",
    });

    await releaseSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
    });

    const acquiredForFailure = await acquireSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      startedAtMs: Date.now(),
      now: Date.now,
    });
    assert.equal(acquiredForFailure.acquired, true);

    const waitingForFailure = gate.waitIfNeeded(fixture.sessionID);
    await delay(20);
    await settleSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      status: "failed",
      settledAtMs: Date.now(),
      now: Date.now,
    });

    assert.deepEqual(await waitingForFailure, {
      waited: true,
      releasedBy: "lock-failed",
      reason: "active compaction lock reached a terminal failure state",
    });

    await releaseSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
    });

    const acquiredForManualClear = await acquireSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      startedAtMs: Date.now(),
      now: Date.now,
    });
    assert.equal(acquiredForManualClear.acquired, true);

    const waitingForManualClear = gate.waitIfNeeded(fixture.sessionID);
    await delay(20);
    await releaseSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
    });

    assert.deepEqual(await waitingForManualClear, {
      waited: true,
      releasedBy: "lock-cleared",
      reason: "active compaction lock was cleared before settlement",
    });

    const immediate = await gate.waitIfNeeded(fixture.sessionID);
    assert.deepEqual(immediate, {
      waited: false,
      releasedBy: "no-lock",
      reason: "no active compaction lock",
    });

    const evidencePath = await fixture.evidence.writeJson("send-entry-gate", {
      successRelease: await waitingForSuccess,
      failedRelease: await waitingForFailure,
      manualClearRelease: await waitingForManualClear,
      immediate,
    });
    assert.match(evidencePath, /send-entry-gate\.json$/u);
  },
);

test(
  "ordinary chat stops waiting when the active lock becomes stale",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "send entry gate timeout",
    });
    const lockRoot = await mkdtemp(join(tmpdir(), "send-entry-gate-timeout-"));
    const lockDirectory = join(lockRoot, "locks");
    let currentTimeMs = 0;
    const gate = createFileLockBackedSendEntryGate({
      lockDirectory,
      timeoutMs: 25,
      pollIntervalMs: 1,
      now: () => currentTimeMs,
      sleep: async () => {
        currentTimeMs += 15;
      },
    });

    const acquired = await acquireSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      startedAtMs: 0,
      now: () => 0,
    });
    assert.equal(acquired.acquired, true);

    const outcome = await gate.waitIfNeeded(fixture.sessionID);
    assert.deepEqual(outcome, {
      waited: true,
      releasedBy: "timeout",
      reason: "active compaction lock exceeded the configured timeout",
    });

    const evidencePath = await fixture.evidence.writeJson(
      "send-entry-gate-timeout",
      outcome,
    );
    assert.match(evidencePath, /send-entry-gate-timeout\.json$/u);
  },
);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
