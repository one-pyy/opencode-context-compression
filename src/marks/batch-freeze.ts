import type { FrozenBatch } from "../runtime/frozen-batch.js";
import { releaseSessionFileLock, type AcquireSessionFileLockResult } from "../runtime/file-lock.js";
import { startFrozenCompactionBatch } from "../runtime/lock-gate.js";
import type {
  CompactionBatchMarkRecord,
  CompactionBatchRecord,
  JsonValue,
  MarkRecord,
  SqliteSessionStateStore,
} from "../state/store.js";

export interface FreezeCurrentCompactionBatchOptions {
  readonly store: SqliteSessionStateStore;
  readonly lockDirectory: string;
  readonly sessionID: string;
  readonly batchID: string;
  readonly canonicalRevision?: string;
  readonly metadata?: JsonValue;
  readonly note?: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export type FreezeCurrentCompactionBatchResult =
  | {
      readonly started: false;
      readonly reason: "no-active-marks";
    }
  | {
      readonly started: false;
      readonly reason: "active-compaction-lock";
      readonly lockPath: string;
      readonly state: Extract<AcquireSessionFileLockResult, { acquired: false }>["state"];
    }
  | {
      readonly started: true;
      readonly runtimeBatch: FrozenBatch<MarkRecord>;
      readonly persistedBatch: CompactionBatchRecord;
      readonly persistedMembers: readonly CompactionBatchMarkRecord[];
      readonly lockPath: string;
      readonly lock: Extract<AcquireSessionFileLockResult, { acquired: true }>["record"];
    };

export async function freezeCurrentCompactionBatch(
  options: FreezeCurrentCompactionBatchOptions,
): Promise<FreezeCurrentCompactionBatchResult> {
  const activeMarks = options.store.listMarks({ status: "active" });
  if (activeMarks.length === 0) {
    return {
      started: false,
      reason: "no-active-marks",
    };
  }

  const startResult = await startFrozenCompactionBatch({
    lockDirectory: options.lockDirectory,
    sessionID: options.sessionID,
    marks: activeMarks,
    identifyMark: (mark) => mark.markID,
    note: options.note,
    now: options.now,
    timeoutMs: options.timeoutMs,
  });

  if (!startResult.started) {
    return {
      started: false,
      reason: "active-compaction-lock",
      lockPath: startResult.lockPath,
      state: startResult.state,
    };
  }

  try {
    const persistedBatch = options.store.createCompactionBatch({
      batchID: options.batchID,
      canonicalRevision: options.canonicalRevision ?? options.store.getSessionState().lastCanonicalRevision,
      frozenAtMs: startResult.batch.frozenAtMs,
      metadata: options.metadata,
      markIDs: startResult.batch.memberIDs,
    });

    return {
      started: true,
      runtimeBatch: startResult.batch,
      persistedBatch,
      persistedMembers: options.store.listCompactionBatchMarks(persistedBatch.batchID),
      lockPath: startResult.lockPath,
      lock: startResult.lock,
    };
  } catch (error) {
    // Clear the lock if SQLite persistence fails so ordinary chat is not blocked by a batch that never existed.
    await releaseSessionFileLock({
      lockDirectory: options.lockDirectory,
      sessionID: options.sessionID,
    });
    throw error;
  }
}
