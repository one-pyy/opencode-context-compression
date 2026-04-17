import type { SqliteDatabase } from "../sqlite-runtime.js";

export type ToastEventType =
  | "compression_start"
  | "compression_complete"
  | "compression_failed";

export interface ToastEvent {
  readonly id: number;
  readonly eventType: ToastEventType;
  readonly createdAt: string;
  readonly payload: string | null;
  readonly processed: number;
}

interface ToastEventRow extends Record<string, unknown> {
  readonly id: number;
  readonly event_type: string;
  readonly created_at: string;
  readonly payload: string | null;
  readonly processed: number;
}

export function writeToastEvent(
  database: SqliteDatabase,
  eventType: ToastEventType,
  payload: string | null = null,
): void {
  const createdAt = new Date().toISOString();

  database
    .prepare(
      `
        INSERT INTO toast_events (event_type, created_at, payload, processed)
        VALUES (:event_type, :created_at, :payload, 0)
      `,
    )
    .run({
      event_type: eventType,
      created_at: createdAt,
      payload,
    });
}

export function readPendingToastEvents(
  database: SqliteDatabase,
): readonly ToastEvent[] {
  return database
    .prepare<ToastEventRow>(
      `
        SELECT id, event_type, created_at, payload, processed
        FROM toast_events
        WHERE processed = 0
        ORDER BY id ASC
      `,
    )
    .all()
    .map((row) => mapToastEventRow(row));
}

export function markToastEventsProcessed(
  database: SqliteDatabase,
  ids: readonly number[],
): void {
  if (ids.length === 0) {
    return;
  }

  const statement = database.prepare(
    `UPDATE toast_events SET processed = 1 WHERE id = :id`
  );

  for (const id of ids) {
    statement.run({ id });
  }
}

function mapToastEventRow(row: ToastEventRow): ToastEvent {
  return {
    id: row.id,
    eventType: row.event_type as ToastEventType,
    createdAt: row.created_at,
    payload: row.payload,
    processed: row.processed,
  };
}
