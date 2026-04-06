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
] as const;

export const SIDECAR_INDEX_NAMES = [
  "idx_result_groups_source_range",
  "idx_visible_sequence_allocations_seq",
  "idx_result_fragments_mark_order",
] as const;

export const SIDECAR_SCHEMA_META = {
  schema_version: "1",
  truth_model: "history-replay-result-groups",
} as const;

type AllowedTableName = (typeof SIDECAR_TABLE_NAMES)[number];
type AllowedIndexName = (typeof SIDECAR_INDEX_NAMES)[number];

const EXPECTED_TABLE_COLUMNS: Record<AllowedTableName, readonly string[]> = {
  schema_meta: ["key", "value"],
  visible_sequence_allocations: [
    "canonical_id",
    "visible_seq",
    "visible_kind",
    "visible_base62",
    "assigned_visible_id",
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
  ],
  result_fragments: [
    "mark_id",
    "fragment_index",
    "source_start_seq",
    "source_end_seq",
    "replacement_text",
  ],
};

interface SqliteObjectRow extends Record<string, unknown> {
  readonly name: string;
  readonly type: "table" | "index" | "view" | "trigger";
}

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
  if (needsDestructiveSchemaReset(database)) {
    dropAllUserSchemaObjects(database);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visible_sequence_allocations (
      canonical_id TEXT PRIMARY KEY,
      visible_seq INTEGER NOT NULL UNIQUE CHECK (visible_seq >= 1),
      visible_kind TEXT NOT NULL,
      visible_base62 TEXT NOT NULL,
      assigned_visible_id TEXT NOT NULL UNIQUE,
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
      payload_sha256 TEXT NOT NULL
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
  `);

  recreateLockedIndexes(database);
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

function needsDestructiveSchemaReset(database: SqliteDatabase): boolean {
  const schemaObjects = listUserSchemaObjects(database);
  if (schemaObjects.length === 0) {
    return false;
  }

  for (const schemaObject of schemaObjects) {
    if (schemaObject.type === "table") {
      if (!isAllowedTableName(schemaObject.name)) {
        return true;
      }

      if (!tableColumnsMatch(database, schemaObject.name)) {
        return true;
      }

      continue;
    }

    if (schemaObject.type === "index") {
      if (!isAllowedIndexName(schemaObject.name)) {
        return true;
      }

      continue;
    }

    return true;
  }

  return false;
}

function dropAllUserSchemaObjects(database: SqliteDatabase): void {
  const schemaObjects = listUserSchemaObjects(database);
  const dropTypeOrder = ["view", "trigger", "index", "table"] as const;

  for (const objectType of dropTypeOrder) {
    for (const schemaObject of schemaObjects) {
      if (schemaObject.type !== objectType) {
        continue;
      }

      database.exec(
        `DROP ${schemaObject.type.toUpperCase()} IF EXISTS ${quoteIdentifier(schemaObject.name)}`,
      );
    }
  }
}

function listUserSchemaObjects(database: SqliteDatabase): readonly SqliteObjectRow[] {
  return database
    .prepare<SqliteObjectRow>(
      `
        SELECT name, type
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY CASE type
          WHEN 'view' THEN 0
          WHEN 'trigger' THEN 1
          WHEN 'index' THEN 2
          ELSE 3
        END,
        name ASC
      `,
    )
    .all();
}

function tableColumnsMatch(
  database: SqliteDatabase,
  tableName: AllowedTableName,
): boolean {
  const actualColumns = database
    .prepare<TableInfoRow>(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => row.name);

  return (
    actualColumns.length === EXPECTED_TABLE_COLUMNS[tableName].length &&
    actualColumns.every(
      (entry, index) => entry === EXPECTED_TABLE_COLUMNS[tableName][index],
    )
  );
}

function isAllowedTableName(value: string): value is AllowedTableName {
  return SIDECAR_TABLE_NAMES.includes(value as AllowedTableName);
}

function isAllowedIndexName(value: string): value is AllowedIndexName {
  return SIDECAR_INDEX_NAMES.includes(value as AllowedIndexName);
}
