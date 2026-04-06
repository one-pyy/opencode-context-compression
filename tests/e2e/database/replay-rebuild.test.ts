import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireSessionFileLock,
  readSessionFileLock,
  releaseSessionFileLock,
} from "../../../src/runtime/file-lock.js";
import { resolveSessionSidecarLayout } from "../../../src/runtime/sidecar-layout.js";
import {
  rebuildSessionSidecarFromReplay,
} from "../../../src/state/sidecar-store.js";
import { createSqliteDatabase } from "../../../src/state/sqlite-runtime.js";

test("full replay rebuild restores the locked sidecar read model after DB removal and keeps restart recovery in the lock file", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-replay-rebuild-"),
  );

  try {
    const layout = resolveSessionSidecarLayout({
      pluginDirectory,
      sessionID: "session-rebuild",
      runtimeLogPath: "logs/runtime-events.jsonl",
      seamLogPath: "logs/seam-observation.jsonl",
      debugSnapshotPath: "state/debug",
    });

    const replayFixture = {
      visibleMessages: [
        {
          canonicalID: "msg-user-1",
          visibleKind: "protected",
          allocatedAt: "2026-04-06T00:00:00.000Z",
        },
        {
          canonicalID: "msg-assistant-1",
          visibleKind: "compressible",
          allocatedAt: "2026-04-06T00:00:01.000Z",
        },
        {
          canonicalID: "msg-tool-1",
          visibleKind: "compressible",
          allocatedAt: "2026-04-06T00:00:02.000Z",
        },
      ],
      resultGroups: [
        {
          markID: "mark-rebuild-1",
          mode: "compact" as const,
          sourceStartSeq: 2,
          sourceEndSeq: 3,
          modelName: "gpt-test-mini",
          executionMode: "background",
          createdAt: "2026-04-06T00:01:00.000Z",
          committedAt: "2026-04-06T00:01:05.000Z",
          fragments: [
            {
              sourceStartSeq: 2,
              sourceEndSeq: 3,
              replacementText: "Compressed assistant/tool span",
            },
          ],
        },
      ],
    };

    await rebuildSessionSidecarFromReplay({
      databasePath: layout.databasePath,
      replayState: replayFixture,
    });

    const firstSnapshot = snapshotSidecarDatabase(layout.databasePath);

    const lock = await acquireSessionFileLock({
      lockDirectory: layout.lockDirectory,
      sessionID: "session-rebuild",
      startedAtMs: 500,
      now: () => 500,
    });
    assert.equal(lock.acquired, true);

    await rm(layout.databasePath, { force: true });

    await rebuildSessionSidecarFromReplay({
      databasePath: layout.databasePath,
      replayState: replayFixture,
    });

    const rebuiltSnapshot = snapshotSidecarDatabase(layout.databasePath);

    assert.deepEqual(rebuiltSnapshot, firstSnapshot);

    const runningLockState = await readSessionFileLock({
      lockDirectory: layout.lockDirectory,
      sessionID: "session-rebuild",
      now: () => 500,
    });
    assert.equal(runningLockState.kind, "running");

    await releaseSessionFileLock({
      lockDirectory: layout.lockDirectory,
      sessionID: "session-rebuild",
    });

    const unlockedState = await readSessionFileLock({
      lockDirectory: layout.lockDirectory,
      sessionID: "session-rebuild",
      now: () => 500,
    });
    assert.equal(unlockedState.kind, "unlocked");
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});

function snapshotSidecarDatabase(databasePath: string): {
  readonly visibleAllocations: readonly {
    readonly canonical_id: string;
    readonly visible_seq: number;
    readonly visible_kind: string;
    readonly visible_base62: string;
    readonly assigned_visible_id: string;
    readonly allocated_at: string;
  }[];
  readonly resultGroups: readonly {
    readonly mark_id: string;
    readonly mode: string;
    readonly source_start_seq: number;
    readonly source_end_seq: number;
    readonly fragment_count: number;
    readonly model_name: string | null;
    readonly execution_mode: string;
    readonly created_at: string;
    readonly committed_at: string | null;
    readonly payload_sha256: string;
  }[];
  readonly resultFragments: readonly {
    readonly mark_id: string;
    readonly fragment_index: number;
    readonly source_start_seq: number;
    readonly source_end_seq: number;
    readonly replacement_text: string;
  }[];
} {
  const database = createSqliteDatabase(databasePath, {
    enableForeignKeyConstraints: true,
  });

  try {
    return {
      visibleAllocations: database
        .prepare<{
          readonly canonical_id: string;
          readonly visible_seq: number;
          readonly visible_kind: string;
          readonly visible_base62: string;
          readonly assigned_visible_id: string;
          readonly allocated_at: string;
        }>(
          `
            SELECT canonical_id, visible_seq, visible_kind, visible_base62, assigned_visible_id, allocated_at
            FROM visible_sequence_allocations
            ORDER BY visible_seq ASC
          `,
        )
        .all(),
      resultGroups: database
        .prepare<{
          readonly mark_id: string;
          readonly mode: string;
          readonly source_start_seq: number;
          readonly source_end_seq: number;
          readonly fragment_count: number;
          readonly model_name: string | null;
          readonly execution_mode: string;
          readonly created_at: string;
          readonly committed_at: string | null;
          readonly payload_sha256: string;
        }>(
          `
            SELECT mark_id, mode, source_start_seq, source_end_seq, fragment_count, model_name, execution_mode, created_at, committed_at, payload_sha256
            FROM result_groups
            ORDER BY mark_id ASC
          `,
        )
        .all(),
      resultFragments: database
        .prepare<{
          readonly mark_id: string;
          readonly fragment_index: number;
          readonly source_start_seq: number;
          readonly source_end_seq: number;
          readonly replacement_text: string;
        }>(
          `
            SELECT mark_id, fragment_index, source_start_seq, source_end_seq, replacement_text
            FROM result_fragments
            ORDER BY mark_id ASC, fragment_index ASC
          `,
        )
        .all(),
    };
  } finally {
    database.close();
  }
}
