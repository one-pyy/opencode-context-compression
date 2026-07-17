import type { SessionSidecarRepositoryWithDatabase } from "./sidecar-store/repository.js";

export const MAX_COMPACTION_FAILURE_COUNT = 3;

export interface CompactionFailure {
  readonly markId: string;
  readonly failureCount: number;
  readonly lastError: string;
  readonly lastFailedAt: string;
}

interface CompactionFailureRow extends Record<string, unknown> {
  readonly mark_id: string;
  readonly failure_count: number;
  readonly last_error: string;
  readonly last_failed_at: string;
}

export function createCompactionFailureRepository(
  repository: SessionSidecarRepositoryWithDatabase,
) {
  function getFailure(markId: string): CompactionFailure | null {
    const row = repository.database
      .prepare<CompactionFailureRow>(
        `SELECT mark_id, failure_count, last_error, last_failed_at
         FROM compaction_failures
         WHERE mark_id = :markId`,
      )
      .get({ markId });

    return row
      ? {
          markId: row.mark_id,
          failureCount: row.failure_count,
          lastError: row.last_error,
          lastFailedAt: row.last_failed_at,
        }
      : null;
  }

  return {
    getFailure,
    recordFailure(input: {
      readonly markId: string;
      readonly lastError: string;
      readonly failedAt: string;
    }): CompactionFailure {
      repository.database
        .prepare(
          `INSERT INTO compaction_failures (mark_id, failure_count, last_error, last_failed_at)
           VALUES (:markId, 1, :lastError, :failedAt)
           ON CONFLICT(mark_id) DO UPDATE SET
             failure_count = MIN(compaction_failures.failure_count + 1, :maxFailureCount),
             last_error = excluded.last_error,
             last_failed_at = excluded.last_failed_at`,
        )
        .run({
          markId: input.markId,
          lastError: input.lastError,
          failedAt: input.failedAt,
          maxFailureCount: MAX_COMPACTION_FAILURE_COUNT,
        });

      const failure = getFailure(input.markId);
      if (failure === null) {
        throw new Error(`Compaction failure row '${input.markId}' was not persisted.`);
      }
      return failure;
    },
    clear(markId: string): void {
      repository.database
        .prepare(`DELETE FROM compaction_failures WHERE mark_id = :markId`)
        .run({ markId });
    },
  };
}
