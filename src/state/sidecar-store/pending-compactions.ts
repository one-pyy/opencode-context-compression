import type { SqliteDatabase } from "../sqlite-runtime.js";

export interface PendingCompaction {
  readonly id: number;
  readonly markId: string;
  readonly createdAt: string;
  readonly processed: number;
}

interface PendingCompactionRow extends Record<string, unknown> {
  readonly id: number;
  readonly mark_id: string;
  readonly created_at: string;
  readonly processed: number;
}

export function writePendingCompaction(
  database: SqliteDatabase,
  markId: string,
): void {
  const createdAt = new Date().toISOString();

  database
    .prepare(
      `
        INSERT INTO pending_compactions (mark_id, created_at, processed)
        VALUES (:mark_id, :created_at, 0)
      `,
    )
    .run({
      mark_id: markId,
      created_at: createdAt,
    });
}

export function readPendingCompactions(
  database: SqliteDatabase,
): readonly PendingCompaction[] {
  return database
    .prepare<PendingCompactionRow>(
      `
        SELECT id, mark_id, created_at, processed
        FROM pending_compactions
        WHERE processed = 0
        ORDER BY id ASC
      `,
    )
    .all()
    .map((row) => mapPendingCompactionRow(row));
}

export function markCompactionsProcessed(
  database: SqliteDatabase,
  ids: readonly number[],
): void {
  if (ids.length === 0) {
    return;
  }

  const statement = database.prepare(
    `UPDATE pending_compactions SET processed = 1 WHERE id = :id`
  );

  for (const id of ids) {
    statement.run({ id });
  }
}

function mapPendingCompactionRow(row: PendingCompactionRow): PendingCompaction {
  return {
    id: row.id,
    markId: row.mark_id,
    createdAt: row.created_at,
    processed: row.processed,
  };
}
