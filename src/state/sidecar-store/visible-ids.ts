import type { SqliteDatabase } from "../sqlite-runtime.js";
import {
  deriveStableBase62Suffix,
  formatAssignedVisibleID,
  runInTransaction,
} from "./helpers.js";
import type {
  AllocateVisibleIDOptions,
  ReplayVisibleMessage,
  SessionSidecarVisibleIDAllocation,
} from "./types.js";

interface VisibleSequenceAllocationRow extends Record<string, unknown> {
  readonly canonical_id: string;
  readonly visible_seq: number;
  readonly visible_kind: string;
  readonly visible_base62: string;
  readonly assigned_visible_id: string;
  readonly allocated_at: string;
}

interface MaxVisibleSequenceRow extends Record<string, unknown> {
  readonly max_visible_seq: number | null;
}

export function insertVisibleSequenceAllocations(
  database: SqliteDatabase,
  visibleMessages: readonly ReplayVisibleMessage[],
): void {
  const insertStatement = database.prepare(
    `
      INSERT INTO visible_sequence_allocations (
        canonical_id,
        visible_seq,
        visible_kind,
        visible_base62,
        assigned_visible_id,
        allocated_at
      )
      VALUES (
        :canonical_id,
        :visible_seq,
        :visible_kind,
        :visible_base62,
        :assigned_visible_id,
        :allocated_at
      )
    `,
  );

  visibleMessages.forEach((message, index) => {
    const visibleSeq = index + 1;
    const visibleBase62 = deriveStableBase62Suffix(message.canonicalID);

    insertStatement.run({
      canonical_id: message.canonicalID,
      visible_seq: visibleSeq,
      visible_kind: message.visibleKind,
      visible_base62: visibleBase62,
      assigned_visible_id: formatAssignedVisibleID(
        message.visibleKind,
        visibleSeq,
        visibleBase62,
      ),
      allocated_at: message.allocatedAt,
    });
  });
}

export function allocateVisibleID(
  database: SqliteDatabase,
  options: AllocateVisibleIDOptions,
): SessionSidecarVisibleIDAllocation {
  assertVisibleIDAllocationOptions(options);

  return runInTransaction(database, () => {
    const existing = readVisibleID(database, options.canonicalID);
    if (existing !== undefined) {
      if (existing.visibleKind !== options.visibleKind) {
        throw new Error(
          `Visible id allocation for canonical id '${options.canonicalID}' already exists with kind '${existing.visibleKind}', not '${options.visibleKind}'.`,
        );
      }

      return existing;
    }

    const nextVisibleSeq =
      (database
        .prepare<MaxVisibleSequenceRow>(
          `SELECT MAX(visible_seq) AS max_visible_seq FROM visible_sequence_allocations`,
        )
        .get()?.max_visible_seq ?? 0) + 1;
    const visibleBase62 = deriveStableBase62Suffix(options.canonicalID);

    database
      .prepare(
        `
          INSERT INTO visible_sequence_allocations (
            canonical_id,
            visible_seq,
            visible_kind,
            visible_base62,
            assigned_visible_id,
            allocated_at
          )
          VALUES (
            :canonical_id,
            :visible_seq,
            :visible_kind,
            :visible_base62,
            :assigned_visible_id,
            :allocated_at
          )
        `,
      )
      .run({
        canonical_id: options.canonicalID,
        visible_seq: nextVisibleSeq,
        visible_kind: options.visibleKind,
        visible_base62: visibleBase62,
        assigned_visible_id: formatAssignedVisibleID(
          options.visibleKind,
          nextVisibleSeq,
          visibleBase62,
        ),
        allocated_at: options.allocatedAt,
      });

    return readVisibleID(database, options.canonicalID)!;
  });
}

export function readVisibleID(
  database: SqliteDatabase,
  canonicalID: string,
): SessionSidecarVisibleIDAllocation | undefined {
  const row = database
    .prepare<VisibleSequenceAllocationRow>(
      `
        SELECT canonical_id, visible_seq, visible_kind, visible_base62, assigned_visible_id, allocated_at
        FROM visible_sequence_allocations
        WHERE canonical_id = :canonical_id
      `,
    )
    .get({ canonical_id: canonicalID });

  return row === undefined ? undefined : mapVisibleIDAllocationRow(row);
}

export function listVisibleIDs(
  database: SqliteDatabase,
): readonly SessionSidecarVisibleIDAllocation[] {
  return database
    .prepare<VisibleSequenceAllocationRow>(
      `
        SELECT canonical_id, visible_seq, visible_kind, visible_base62, assigned_visible_id, allocated_at
        FROM visible_sequence_allocations
        ORDER BY visible_seq ASC
      `,
    )
    .all()
    .map((row) => mapVisibleIDAllocationRow(row));
}

function assertVisibleIDAllocationOptions(
  options: AllocateVisibleIDOptions,
): void {
  if (options.canonicalID.length === 0) {
    throw new Error("Visible id allocation requires a non-empty canonicalID.");
  }

  if (options.visibleKind.length === 0) {
    throw new Error("Visible id allocation requires a non-empty visibleKind.");
  }

  if (options.allocatedAt.length === 0) {
    throw new Error(
      "Visible id allocation requires a non-empty allocatedAt timestamp.",
    );
  }
}

function mapVisibleIDAllocationRow(
  row: VisibleSequenceAllocationRow,
): SessionSidecarVisibleIDAllocation {
  return {
    canonicalID: row.canonical_id,
    visibleSeq: row.visible_seq,
    visibleKind: row.visible_kind,
    visibleBase62: row.visible_base62,
    assignedVisibleID: row.assigned_visible_id,
    allocatedAt: row.allocated_at,
  };
}
