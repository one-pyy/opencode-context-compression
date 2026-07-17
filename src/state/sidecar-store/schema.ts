import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createSqliteDatabase,
  type SqliteDatabase,
} from "../sqlite-runtime.js";
import { quoteIdentifier } from "./helpers.js";
import type { BootstrapSessionSidecarOptions } from "./types.js";

export const SIDECAR_TABLE_NAMES = [
  "schema_meta",
  "visible_sequence_allocations",
  "result_groups",
  "result_fragments",
  "compaction_failures",
  "toast_events",
] as const;

export const SIDECAR_INDEX_NAMES = [
  "idx_result_groups_source_range",
  "idx_visible_sequence_allocations_seq",
  "idx_result_fragments_mark_order",
] as const;

export const SIDECAR_SCHEMA_META = {
  schema_version: "2",
  truth_model: "history-replay-result-groups",
} as const;

type AllowedTableName = (typeof SIDECAR_TABLE_NAMES)[number];

const EXPECTED_TABLE_COLUMNS: Record<AllowedTableName, readonly string[]> = {
  schema_meta: ["key", "value"],
  visible_sequence_allocations: [
    "canonical_id",
    "visible_seq",
    "visible_base62",
    "allocated_at",
  ],
  result_groups: [
    "mark_id",
    "mode",
    "source_start_seq",
    "source_end_seq",
    "fragment_count",
    "model_name",
    "execution_mode",
    "created_at",
    "committed_at",
    "payload_sha256",
    "applied",
  ],
  result_fragments: [
    "mark_id",
    "fragment_index",
    "source_start_seq",
    "source_end_seq",
    "replacement_text",
  ],
  compaction_failures: [
    "mark_id",
    "failure_count",
    "last_error",
    "last_failed_at",
  ],
  toast_events: [
    "id",
    "event_type",
    "created_at",
    "payload",
    "processed",
  ],
};

interface TableInfoRow extends Record<string, unknown> {
  readonly name: string;
}

export async function bootstrapSessionSidecar(
  options: BootstrapSessionSidecarOptions,
): Promise<void> {
  const database = await openLockedSessionSidecarDatabase(options.databasePath);

  try {
  } finally {
    database.close();
  }
}

export async function openLockedSessionSidecarDatabase(
  databasePath: string,
): Promise<SqliteDatabase> {
  await mkdir(dirname(databasePath), { recursive: true });
  const database = createConfiguredDatabase(databasePath);
  ensureLockedSidecarSchema(database);
  return database;
}

export function ensureLockedSidecarSchema(database: SqliteDatabase): void {
  migrateResultGroupsAppliedColumn(database);
  migrateCompactionFailuresTable(database);
  dropKnownLegacyTables(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visible_sequence_allocations (
      canonical_id TEXT PRIMARY KEY,
      visible_seq INTEGER NOT NULL UNIQUE CHECK (visible_seq >= 1),
      visible_base62 TEXT NOT NULL,
      allocated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS result_groups (
      mark_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('compact', 'delete')),
      source_start_seq INTEGER NOT NULL,
      source_end_seq INTEGER NOT NULL,
      fragment_count INTEGER NOT NULL CHECK (fragment_count >= 1),
      model_name TEXT,
      execution_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      committed_at TEXT,
      payload_sha256 TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS result_fragments (
      mark_id TEXT NOT NULL,
      fragment_index INTEGER NOT NULL,
      source_start_seq INTEGER NOT NULL,
      source_end_seq INTEGER NOT NULL,
      replacement_text TEXT NOT NULL,
      PRIMARY KEY (mark_id, fragment_index),
      FOREIGN KEY (mark_id) REFERENCES result_groups(mark_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS toast_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL CHECK (event_type IN ('compression_start', 'compression_complete', 'compression_failed')),
      created_at TEXT NOT NULL,
      payload TEXT,
      processed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS compaction_failures (
      mark_id TEXT PRIMARY KEY,
      failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 1 AND 3),
      last_error TEXT NOT NULL,
      last_failed_at TEXT NOT NULL
    );

    `);

  recreateLockedIndexes(database);
  validateRequiredTableColumns(database);
  upsertSchemaMeta(database);
}

function createConfiguredDatabase(databasePath: string): SqliteDatabase {
  const database = createSqliteDatabase(databasePath, {
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA synchronous = FULL;");
  return database;
}

function recreateLockedIndexes(database: SqliteDatabase): void {
  for (const indexName of SIDECAR_INDEX_NAMES) {
    database.exec(`DROP INDEX IF EXISTS ${quoteIdentifier(indexName)}`);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_result_groups_source_range
      ON result_groups(source_start_seq, source_end_seq);

    CREATE INDEX IF NOT EXISTS idx_visible_sequence_allocations_seq
      ON visible_sequence_allocations(visible_seq);

    CREATE INDEX IF NOT EXISTS idx_result_fragments_mark_order
      ON result_fragments(mark_id, fragment_index);
  `);
}

function upsertSchemaMeta(database: SqliteDatabase): void {
  const statement = database.prepare(
    `
      INSERT INTO schema_meta (key, value)
      VALUES (:key, :value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  );

  for (const [key, value] of Object.entries(SIDECAR_SCHEMA_META)) {
    statement.run({ key, value });
  }
}

function dropKnownLegacyTables(database: SqliteDatabase): void {
  database.exec(`DROP TABLE IF EXISTS ${quoteIdentifier("pending_compactions")}`);
}

function validateRequiredTableColumns(database: SqliteDatabase): void {
  for (const tableName of SIDECAR_TABLE_NAMES) {
    const actualColumns = listTableColumns(database, tableName);
    for (const expectedColumn of EXPECTED_TABLE_COLUMNS[tableName]) {
      if (!actualColumns.includes(expectedColumn)) {
        throw new Error(
          `Session sidecar table '${tableName}' is missing required column '${expectedColumn}'.`,
        );
      }
    }
  }
}

function listTableColumns(
  database: SqliteDatabase,
  tableName: AllowedTableName,
): readonly string[] {
  const actualColumns = database
    .prepare<TableInfoRow>(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => row.name);
  return actualColumns;
}

function migrateResultGroupsAppliedColumn(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS result_groups (
      mark_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('compact', 'delete')),
      source_start_seq INTEGER NOT NULL,
      source_end_seq INTEGER NOT NULL,
      fragment_count INTEGER NOT NULL CHECK (fragment_count >= 1),
      model_name TEXT,
      execution_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      committed_at TEXT,
      payload_sha256 TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0
    );
  `);

  const columns = database
    .prepare<TableInfoRow>(`PRAGMA table_info(result_groups)`)
    .all()
    .map((row) => row.name);

  if (!columns.includes("applied")) {
    database.exec(
      `ALTER TABLE result_groups ADD COLUMN applied INTEGER NOT NULL DEFAULT 0`,
    );
  }
}

function migrateCompactionFailuresTable(database: SqliteDatabase): void {
  const columns = database
    .prepare<TableInfoRow>(`PRAGMA table_info(compaction_failures)`)
    .all()
    .map((row) => row.name);
  if (!columns.includes("rounds") || columns.includes("failure_count")) {
    return;
  }

  database.exec(`
    ALTER TABLE compaction_failures RENAME TO compaction_failures_legacy_rounds;

    CREATE TABLE compaction_failures (
      mark_id TEXT PRIMARY KEY,
      failure_count INTEGER NOT NULL CHECK (failure_count BETWEEN 1 AND 3),
      last_error TEXT NOT NULL,
      last_failed_at TEXT NOT NULL
    );

    INSERT INTO compaction_failures (
      mark_id,
      failure_count,
      last_error,
      last_failed_at
    )
    SELECT
      mark_id,
      MIN(MAX(rounds, 1), 3),
      last_error,
      failed_at
    FROM compaction_failures_legacy_rounds;

    DROP TABLE compaction_failures_legacy_rounds;
  `);
}
