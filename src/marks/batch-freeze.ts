import type { FrozenBatch } from "../runtime/frozen-batch.js";
import {
  releaseSessionFileLock,
  type AcquireSessionFileLockResult,
} from "../runtime/file-lock.js";
import { freezeBatchAt } from "../runtime/frozen-batch.js";
import { beginFrozenCompactionDispatch } from "../runtime/lock-gate.js";
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
      readonly state: Extract<
        AcquireSessionFileLockResult,
        { acquired: false }
      >["state"];
    }
  | {
      readonly started: true;
      readonly runtimeBatch: FrozenBatch<MarkRecord>;
      readonly persistedBatch: CompactionBatchRecord;
      readonly persistedMembers: readonly CompactionBatchMarkRecord[];
      readonly lockPath: string;
      readonly lock: Extract<
        AcquireSessionFileLockResult,
        { acquired: true }
      >["record"];
    };

export async function freezeCurrentCompactionBatch(
  options: FreezeCurrentCompactionBatchOptions,
): Promise<FreezeCurrentCompactionBatchResult> {
  const dispatch = await beginFrozenCompactionDispatch({
    lockDirectory: options.lockDirectory,
    sessionID: options.sessionID,
    note: options.note,
    now: options.now,
    timeoutMs: options.timeoutMs,
  });

  if (!dispatch.started) {
    return {
      started: false,
      reason: "active-compaction-lock",
      lockPath: dispatch.lockPath,
      state: dispatch.state,
    };
  }

  const frozenMembers = options.store
    .listMarks({ status: "active" })
    .filter((mark) => mark.createdAtMs <= dispatch.frozenAtMs);
  if (frozenMembers.length === 0) {
    await releaseSessionFileLock({
      lockDirectory: options.lockDirectory,
      sessionID: options.sessionID,
    });
    return {
      started: false,
      reason: "no-active-marks",
    };
  }

  const runtimeBatch = freezeBatchAt(
    frozenMembers,
    (mark) => mark.markID,
    dispatch.frozenAtMs,
  );

  try {
    const persistedBatch = options.store.createCompactionBatch({
      batchID: options.batchID,
      canonicalRevision:
        options.canonicalRevision ??
        options.store.getSessionState().lastCanonicalRevision,
      frozenAtMs: runtimeBatch.frozenAtMs,
      metadata: options.metadata,
      markIDs: runtimeBatch.memberIDs,
    });

    return {
      started: true,
      runtimeBatch,
      persistedBatch,
      persistedMembers: options.store.listCompactionBatchMarks(
        persistedBatch.batchID,
      ),
      lockPath: dispatch.lockPath,
      lock: dispatch.lock,
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
