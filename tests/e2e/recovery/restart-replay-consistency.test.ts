import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCanonicalIdentityService,
} from "../../../src/identity/canonical-identity.js";
import {
  createHistoryReplayReaderFromSources,
  type CanonicalHostMessage,
} from "../../../src/history/history-replay-reader.js";
import { createFlatPolicyEngine } from "../../../src/projection/policy-engine.js";
import { createProjectionBuilder } from "../../../src/projection/projection-builder.js";
import { createStaticReminderService } from "../../../src/projection/reminder-service.js";
import {
  acquireSessionFileLock,
  readSessionFileLock,
  releaseSessionFileLock,
} from "../../../src/runtime/file-lock.js";
import { createFileLockBackedSendEntryGate } from "../../../src/runtime/send-entry-gate.js";
import {
  resolvePluginStateDirectory,
  resolveSessionDatabasePath,
} from "../../../src/runtime/sidecar-layout.js";
import { createResultGroupRepository } from "../../../src/state/result-group-repository.js";
import {
  bootstrapSessionSidecar,
  openSessionSidecarRepository,
} from "../../../src/state/sidecar-store.js";
import { createSqliteDatabase } from "../../../src/state/sqlite-runtime.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "restart during an in-flight compaction rebuilds the same projection from host history plus sidecar and exposes no partial parent result",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "recovery",
      caseName: "restart replay consistency",
    });
    const stateDirectory = resolvePluginStateDirectory(fixture.repoRoot);
    const databasePath = resolveSessionDatabasePath(stateDirectory, fixture.sessionID);
    await rm(databasePath, { force: true });
    await bootstrapSessionSidecar({ databasePath });

    const lockRoot = await mkdtemp(join(tmpdir(), "restart-replay-locks-"));
    const lockDirectory = join(lockRoot, "locks");
    t.after(async () => {
      await rm(lockRoot, { force: true, recursive: true });
    });

    const history = createRestartHistory();

    const firstSidecar = await openSessionSidecarRepository({ databasePath });
    const firstResultGroups = createResultGroupRepository(firstSidecar);
    const firstIdentity = createCanonicalIdentityService({
      visibleIds: firstResultGroups,
      allocateAt: () => "2026-04-06T14:00:00.000Z",
    });

    const visibleIds = await allocateHistoryVisibleIds(firstIdentity, history.hostHistory);
    await firstResultGroups.upsertCompleteGroup({
      markId: "mark-child-001",
      mode: "compact",
      sourceStartSeq: 2,
      sourceEndSeq: 2,
      executionMode: "compact",
      createdAt: "2026-04-06T14:01:00.000Z",
      committedAt: "2026-04-06T14:01:01.000Z",
      fragments: [
        {
          sourceStartSeq: 2,
          sourceEndSeq: 2,
          replacementText: "Assistant summary survives restart while the parent compaction is still in flight.",
        },
      ],
    });

    const acquired = await acquireSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      startedAtMs: 0,
      now: () => 0,
      note: "in-flight parent compaction before crash",
    });
    assert.equal(acquired.acquired, true);

    const beforeRestartProjection = await buildProjectionSnapshot({
      sessionId: fixture.sessionID,
      resultGroups: firstResultGroups,
      identity: firstIdentity,
      hostHistory: history.hostHistory,
      toolHistory: [
        createCompactMarkToolEntry({
          sequence: 5,
          sourceMessageId: "tool-mark-child",
          markId: "mark-child-001",
          startVisibleMessageId: visibleIds.assistant1,
          endVisibleMessageId: visibleIds.assistant1,
        }),
        createCompactMarkToolEntry({
          sequence: 6,
          sourceMessageId: "tool-mark-parent",
          markId: "mark-parent-001",
          startVisibleMessageId: visibleIds.user1,
          endVisibleMessageId: visibleIds.user2,
        }),
      ],
    });

    firstSidecar.close();

    const secondSidecar = await openSessionSidecarRepository({ databasePath });
    t.after(() => secondSidecar.close());
    const secondResultGroups = createResultGroupRepository(secondSidecar);
    const secondIdentity = createCanonicalIdentityService({
      visibleIds: secondResultGroups,
      allocateAt: () => "2026-04-06T14:10:00.000Z",
    });

    const lockStateOnRestart = await readSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      now: () => 10,
    });
    assert.equal(lockStateOnRestart.kind, "running");

    const afterRestartProjection = await buildProjectionSnapshot({
      sessionId: fixture.sessionID,
      resultGroups: secondResultGroups,
      identity: secondIdentity,
      hostHistory: history.hostHistory,
      toolHistory: [
        createCompactMarkToolEntry({
          sequence: 5,
          sourceMessageId: "tool-mark-child",
          markId: "mark-child-001",
          startVisibleMessageId: visibleIds.assistant1,
          endVisibleMessageId: visibleIds.assistant1,
        }),
        createCompactMarkToolEntry({
          sequence: 6,
          sourceMessageId: "tool-mark-parent",
          markId: "mark-parent-001",
          startVisibleMessageId: visibleIds.user1,
          endVisibleMessageId: visibleIds.user2,
        }),
      ],
    });

    assert.deepEqual(afterRestartProjection, beforeRestartProjection);
    assert.equal(await secondResultGroups.getCompleteGroup("mark-parent-001"), null);
    assert.deepEqual(readMarkPersistenceCounts(databasePath, "mark-parent-001"), {
      groupCount: 0,
      fragmentCount: 0,
    });
    assert.ok(afterRestartProjection.some((message) => message.includes("Assistant summary survives restart")));
    assert.ok(afterRestartProjection.some((message) => message.includes("Tool details remain visible as the original gap")));

    const evidencePath = await fixture.evidence.writeJson(
      "restart-replay-consistency",
      {
        lockStateOnRestart,
        beforeRestartProjection,
        afterRestartProjection,
        parentCounts: readMarkPersistenceCounts(databasePath, "mark-parent-001"),
      },
    );
    assert.match(evidencePath, /restart-replay-consistency\.json$/u);
  },
);

test(
  "stale locks time out and manual unlock clears a restarted session without operator-only recovery",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "recovery",
      caseName: "restart stale lock manual unlock",
    });
    const lockRoot = await mkdtemp(join(tmpdir(), "restart-stale-lock-"));
    const lockDirectory = join(lockRoot, "locks");
    t.after(async () => {
      await rm(lockRoot, { force: true, recursive: true });
    });

    const staleAcquired = await acquireSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      startedAtMs: 0,
      now: () => 0,
      note: "orphaned stale lock",
    });
    assert.equal(staleAcquired.acquired, true);

    let currentTimeMs = 0;
    const staleGate = createFileLockBackedSendEntryGate({
      lockDirectory,
      timeoutMs: 25,
      pollIntervalMs: 1,
      now: () => currentTimeMs,
      sleep: async () => {
        currentTimeMs += 15;
      },
    });

    const staleOutcome = await staleGate.waitIfNeeded(fixture.sessionID);
    assert.deepEqual(staleOutcome, {
      waited: true,
      releasedBy: "timeout",
      reason: "active compaction lock exceeded the configured timeout",
    });
    assert.equal(
      (
        await readSessionFileLock({
          lockDirectory,
          sessionID: fixture.sessionID,
          now: () => currentTimeMs,
          timeoutMs: 25,
        })
      ).kind,
      "stale",
    );

    await releaseSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
    });
    assert.equal(
      (
        await readSessionFileLock({
          lockDirectory,
          sessionID: fixture.sessionID,
          now: () => currentTimeMs,
          timeoutMs: 25,
        })
      ).kind,
      "unlocked",
    );

    const manualAcquired = await acquireSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
      startedAtMs: Date.now(),
      now: Date.now,
      note: "manual unlock path",
    });
    assert.equal(manualAcquired.acquired, true);

    const manualGate = createFileLockBackedSendEntryGate({
      lockDirectory,
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    const waitingForManualUnlock = manualGate.waitIfNeeded(fixture.sessionID);
    await delay(20);
    await releaseSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
    });

    assert.deepEqual(await waitingForManualUnlock, {
      waited: true,
      releasedBy: "lock-cleared",
      reason: "active compaction lock was cleared before settlement",
    });

    const evidencePath = await fixture.evidence.writeJson(
      "restart-stale-lock-manual-unlock",
      {
        staleOutcome,
        manualOutcome: await waitingForManualUnlock,
      },
    );
    assert.match(evidencePath, /restart-stale-lock-manual-unlock\.json$/u);
  },
);

function createRestartHistory() {
  return {
    hostHistory: [
      hostEntry(
        1,
        createMessage("msg-user-1", "user", "User context stays visible around the restarted compaction."),
      ),
      hostEntry(
        2,
        createMessage("msg-assistant-1", "assistant", "Assistant details are already covered by a child result."),
      ),
      hostEntry(
        3,
        createMessage("msg-tool-1", "tool", "Tool details remain visible as the original gap while the parent is missing."),
      ),
      hostEntry(
        4,
        createMessage("msg-user-2", "user", "Later user context stays visible after restart replay."),
      ),
    ] as const,
  };
}

async function allocateHistoryVisibleIds(
  identity: ReturnType<typeof createCanonicalIdentityService>,
  hostHistory: readonly ReturnType<typeof hostEntry>[],
) {
  const [user1, assistant1, tool1, user2] = await Promise.all([
    identity.allocateVisibleId(hostHistory[0]!.message.info.id, "compressible"),
    identity.allocateVisibleId(hostHistory[1]!.message.info.id, "compressible"),
    identity.allocateVisibleId(hostHistory[2]!.message.info.id, "compressible"),
    identity.allocateVisibleId(hostHistory[3]!.message.info.id, "compressible"),
  ]);

  return {
    user1: user1.assignedVisibleId,
    assistant1: assistant1.assignedVisibleId,
    tool1: tool1.assignedVisibleId,
    user2: user2.assignedVisibleId,
  };
}

async function buildProjectionSnapshot(input: {
  readonly sessionId: string;
  readonly resultGroups: ReturnType<typeof createResultGroupRepository>;
  readonly identity: ReturnType<typeof createCanonicalIdentityService>;
  readonly hostHistory: readonly ReturnType<typeof hostEntry>[];
  readonly toolHistory: readonly ReturnType<typeof createCompactMarkToolEntry>[];
}): Promise<string[]> {
  const projectionBuilder = createProjectionBuilder({
    historyReplayReader: createHistoryReplayReaderFromSources({
      sessionId: input.sessionId,
      hostHistory: input.hostHistory,
      toolHistory: input.toolHistory,
    }),
    policyEngine: createFlatPolicyEngine({
      smallUserMessageThreshold: 5,
    }),
    resultGroupRepository: input.resultGroups,
    canonicalIdentityService: input.identity,
    reminderService: createStaticReminderService(),
  });

  const projection = await projectionBuilder.build({
    sessionId: input.sessionId,
  });
  return projection.messages.map((message) => message.contentText);
}

function createCompactMarkToolEntry(input: {
  readonly sequence: number;
  readonly sourceMessageId: string;
  readonly markId: string;
  readonly startVisibleMessageId: string;
  readonly endVisibleMessageId: string;
}) {
  return {
    sequence: input.sequence,
    sourceMessageId: input.sourceMessageId,
    toolName: "compression_mark" as const,
    input: {
      contractVersion: "v1" as const,
      mode: "compact" as const,
      target: {
        startVisibleMessageID: input.startVisibleMessageId,
        endVisibleMessageID: input.endVisibleMessageId,
      },
    },
    result: {
      ok: true as const,
      markId: input.markId,
    },
  };
}

function readMarkPersistenceCounts(databasePath: string, markId: string) {
  const database = createSqliteDatabase(databasePath, {
    enableForeignKeyConstraints: true,
  });

  try {
    const groupCount = database
      .prepare<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM result_groups WHERE mark_id = :mark_id`,
      )
      .get({ mark_id: markId })?.count;
    const fragmentCount = database
      .prepare<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM result_fragments WHERE mark_id = :mark_id`,
      )
      .get({ mark_id: markId })?.count;

    return {
      groupCount: groupCount ?? 0,
      fragmentCount: fragmentCount ?? 0,
    };
  } finally {
    database.close();
  }
}

function hostEntry(sequence: number, message: CanonicalHostMessage) {
  return {
    sequence,
    message,
  };
}

function createMessage(
  id: string,
  role: "system" | "user" | "assistant" | "tool",
  text: string,
): CanonicalHostMessage {
  return {
    info: {
      id,
      role,
    },
    parts: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
