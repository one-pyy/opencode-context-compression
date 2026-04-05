import type { SqliteDatabase } from "./sqlite-runtime.js";

export const STATE_SCHEMA_MIGRATION_TABLE = "state_schema_migrations";
export const CURRENT_STATE_SCHEMA_VERSION = 2;

export const STATE_TABLE_NAMES = Object.freeze([
  "session_state",
  "host_messages",
  "visible_sequence_state",
  "source_snapshots",
  "source_snapshot_messages",
  "marks",
  "replacements",
  "replacement_mark_links",
  "compaction_batches",
  "compaction_batch_marks",
  "compaction_jobs",
  "compaction_job_attempts",
  "runtime_gate_audit",
]);

interface StateSchemaMigration {
  readonly version: number;
  apply(database: SqliteDatabase): void;
}

const MIGRATION_1_SQL = `
CREATE TABLE IF NOT EXISTS session_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_canonical_revision TEXT,
  last_synced_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO session_state (id, updated_at_ms)
VALUES (1, 0);

CREATE TABLE IF NOT EXISTS host_messages (
  host_message_id TEXT PRIMARY KEY,
  canonical_message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  host_created_at_ms INTEGER,
  canonical_present INTEGER NOT NULL DEFAULT 1,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  last_seen_revision TEXT,
  visible_seq INTEGER,
  visible_checksum TEXT,
  metadata_json TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_host_messages_visible_seq
ON host_messages (visible_seq)
WHERE visible_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_host_messages_present
ON host_messages (canonical_present, last_seen_at_ms);

CREATE TABLE IF NOT EXISTS visible_sequence_state (
  allocator_name TEXT PRIMARY KEY CHECK (allocator_name = 'default'),
  next_seq INTEGER NOT NULL CHECK (next_seq >= 1),
  updated_at_ms INTEGER NOT NULL
);

INSERT OR IGNORE INTO visible_sequence_state (allocator_name, next_seq, updated_at_ms)
VALUES ('default', 1, 0);

CREATE TABLE IF NOT EXISTS source_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('mark', 'replacement')),
  allow_delete INTEGER NOT NULL CHECK (allow_delete IN (0, 1)),
  source_fingerprint TEXT NOT NULL,
  canonical_revision TEXT,
  source_count INTEGER NOT NULL CHECK (source_count >= 1),
  created_at_ms INTEGER NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_snapshots_lookup
ON source_snapshots (snapshot_kind, allow_delete, source_fingerprint, created_at_ms);

CREATE TABLE IF NOT EXISTS source_snapshot_messages (
  snapshot_id TEXT NOT NULL,
  source_index INTEGER NOT NULL CHECK (source_index >= 0),
  host_message_id TEXT NOT NULL,
  canonical_message_id TEXT NOT NULL,
  host_role TEXT NOT NULL,
  content_hash TEXT,
  metadata_json TEXT,
  PRIMARY KEY (snapshot_id, source_index),
  FOREIGN KEY (snapshot_id) REFERENCES source_snapshots(snapshot_id) ON DELETE CASCADE,
  FOREIGN KEY (host_message_id) REFERENCES host_messages(host_message_id)
);

CREATE INDEX IF NOT EXISTS idx_source_snapshot_messages_host_message
ON source_snapshot_messages (host_message_id);

CREATE TABLE IF NOT EXISTS marks (
  mark_id TEXT PRIMARY KEY,
  tool_call_message_id TEXT NOT NULL UNIQUE,
  allow_delete INTEGER NOT NULL CHECK (allow_delete IN (0, 1)),
  mark_label TEXT,
  source_snapshot_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'invalid')),
  created_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  invalidated_at_ms INTEGER,
  invalidation_reason TEXT,
  metadata_json TEXT,
  FOREIGN KEY (tool_call_message_id) REFERENCES host_messages(host_message_id),
  FOREIGN KEY (source_snapshot_id) REFERENCES source_snapshots(snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_marks_lookup
ON marks (tool_call_message_id, status);

CREATE INDEX IF NOT EXISTS idx_marks_source_snapshot
ON marks (source_snapshot_id);

CREATE TABLE IF NOT EXISTS compaction_batches (
  batch_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('frozen', 'running', 'succeeded', 'failed', 'cancelled')),
  frozen_at_ms INTEGER NOT NULL,
  canonical_revision TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_compaction_batches_status
ON compaction_batches (status, frozen_at_ms);

CREATE TABLE IF NOT EXISTS compaction_batch_marks (
  batch_id TEXT NOT NULL,
  member_index INTEGER NOT NULL CHECK (member_index >= 0),
  mark_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  allow_delete INTEGER NOT NULL CHECK (allow_delete IN (0, 1)),
  PRIMARY KEY (batch_id, mark_id),
  UNIQUE (batch_id, member_index),
  FOREIGN KEY (batch_id) REFERENCES compaction_batches(batch_id) ON DELETE CASCADE,
  FOREIGN KEY (mark_id) REFERENCES marks(mark_id),
  FOREIGN KEY (source_snapshot_id) REFERENCES source_snapshots(snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_compaction_batch_marks_mark
ON compaction_batch_marks (mark_id, batch_id);

CREATE TABLE IF NOT EXISTS compaction_jobs (
  job_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  mark_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'stale', 'cancelled')),
  queued_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  final_error_code TEXT,
  final_error_text TEXT,
  metadata_json TEXT,
  FOREIGN KEY (batch_id) REFERENCES compaction_batches(batch_id),
  FOREIGN KEY (mark_id) REFERENCES marks(mark_id),
  FOREIGN KEY (source_snapshot_id) REFERENCES source_snapshots(snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_compaction_jobs_batch
ON compaction_jobs (batch_id, status, queued_at_ms);

CREATE INDEX IF NOT EXISTS idx_compaction_jobs_mark
ON compaction_jobs (mark_id, status, queued_at_ms);

CREATE TABLE IF NOT EXISTS replacements (
  replacement_id TEXT PRIMARY KEY,
  allow_delete INTEGER NOT NULL CHECK (allow_delete IN (0, 1)),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('compact', 'delete')),
  source_snapshot_id TEXT NOT NULL,
  batch_id TEXT,
  job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('committed', 'invalidated')),
  content_text TEXT,
  content_json TEXT,
  committed_at_ms INTEGER NOT NULL,
  invalidated_at_ms INTEGER,
  invalidation_kind TEXT,
  invalidated_by_mark_id TEXT,
  metadata_json TEXT,
  FOREIGN KEY (source_snapshot_id) REFERENCES source_snapshots(snapshot_id),
  FOREIGN KEY (batch_id) REFERENCES compaction_batches(batch_id),
  FOREIGN KEY (job_id) REFERENCES compaction_jobs(job_id),
  FOREIGN KEY (invalidated_by_mark_id) REFERENCES marks(mark_id)
);

CREATE INDEX IF NOT EXISTS idx_replacements_matchable
ON replacements (allow_delete, status, committed_at_ms);

CREATE INDEX IF NOT EXISTS idx_replacements_job
ON replacements (job_id);

CREATE TABLE IF NOT EXISTS replacement_mark_links (
  replacement_id TEXT NOT NULL,
  mark_id TEXT NOT NULL,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('consumed')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (replacement_id, mark_id),
  FOREIGN KEY (replacement_id) REFERENCES replacements(replacement_id) ON DELETE CASCADE,
  FOREIGN KEY (mark_id) REFERENCES marks(mark_id)
);

CREATE INDEX IF NOT EXISTS idx_replacement_mark_links_mark
ON replacement_mark_links (mark_id, replacement_id);

CREATE TABLE IF NOT EXISTS compaction_job_attempts (
  job_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
  model_index INTEGER NOT NULL CHECK (model_index >= 0),
  model_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  error_code TEXT,
  error_text TEXT,
  replacement_id TEXT,
  metadata_json TEXT,
  PRIMARY KEY (job_id, attempt_index),
  FOREIGN KEY (job_id) REFERENCES compaction_jobs(job_id) ON DELETE CASCADE,
  FOREIGN KEY (replacement_id) REFERENCES replacements(replacement_id)
);

CREATE INDEX IF NOT EXISTS idx_compaction_job_attempts_status
ON compaction_job_attempts (job_id, status, attempt_index);

CREATE TABLE IF NOT EXISTS runtime_gate_audit (
  observation_id TEXT PRIMARY KEY,
  gate_name TEXT NOT NULL CHECK (gate_name = 'compressing'),
  authority TEXT NOT NULL CHECK (authority = 'file-lock'),
  observed_state TEXT NOT NULL CHECK (
    observed_state IN ('unlocked', 'running', 'succeeded', 'failed', 'stale', 'manually-cleared')
  ),
  lock_path TEXT,
  observed_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  settled_at_ms INTEGER,
  active_job_count INTEGER,
  note TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_gate_audit_latest
ON runtime_gate_audit (gate_name, observed_at_ms DESC);
`;

const STATE_SCHEMA_MIGRATIONS: readonly StateSchemaMigration[] = Object.freeze([
  {
    version: 1,
    apply(database) {
      database.exec(MIGRATION_1_SQL);
    },
  },
  {
    version: 2,
    apply(database) {
      if (!hasLegacyRouteColumns(database)) {
        return;
      }

      database.exec(`
DROP INDEX IF EXISTS idx_source_snapshots_lookup;
DROP INDEX IF EXISTS idx_replacements_matchable;

ALTER TABLE source_snapshots RENAME TO source_snapshots_v1;
CREATE TABLE source_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('mark', 'replacement')),
  allow_delete INTEGER NOT NULL CHECK (allow_delete IN (0, 1)),
  source_fingerprint TEXT NOT NULL,
  canonical_revision TEXT,
  source_count INTEGER NOT NULL CHECK (source_count >= 1),
  created_at_ms INTEGER NOT NULL,
  metadata_json TEXT
);
INSERT INTO source_snapshots (
  snapshot_id,
  snapshot_kind,
  allow_delete,
  source_fingerprint,
  canonical_revision,
  source_count,
  created_at_ms,
  metadata_json
)
SELECT
  snapshot_id,
  snapshot_kind,
  CASE route WHEN 'delete' THEN 1 ELSE 0 END,
  source_fingerprint,
  canonical_revision,
  source_count,
  created_at_ms,
  metadata_json
FROM source_snapshots_v1;
DROP TABLE source_snapshots_v1;
CREATE INDEX idx_source_snapshots_lookup
ON source_snapshots (snapshot_kind, allow_delete, source_fingerprint, created_at_ms);

ALTER TABLE marks RENAME TO marks_v1;
CREATE TABLE marks (
  mark_id TEXT PRIMARY KEY,
  tool_call_message_id TEXT NOT NULL UNIQUE,
  allow_delete INTEGER NOT NULL CHECK (allow_delete IN (0, 1)),
  mark_label TEXT,
  source_snapshot_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'invalid')),
  created_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  invalidated_at_ms INTEGER,
  invalidation_reason TEXT,
  metadata_json TEXT,
  FOREIGN KEY (tool_call_message_id) REFERENCES host_messages(host_message_id),
  FOREIGN KEY (source_snapshot_id) REFERENCES source_snapshots(snapshot_id)
);
INSERT INTO marks (
  mark_id,
  tool_call_message_id,
  allow_delete,
  mark_label,
  source_snapshot_id,
  status,
  created_at_ms,
  consumed_at_ms,
  invalidated_at_ms,
  invalidation_reason,
  metadata_json
)
SELECT
  mark_id,
  tool_call_message_id,
  CASE route WHEN 'delete' THEN 1 ELSE 0 END,
  mark_label,
  source_snapshot_id,
  status,
  created_at_ms,
  consumed_at_ms,
  invalidated_at_ms,
  invalidation_reason,
  metadata_json
FROM marks_v1;
DROP TABLE marks_v1;
CREATE INDEX idx_marks_lookup
ON marks (tool_call_message_id, status);
CREATE INDEX idx_marks_source_snapshot
ON marks (source_snapshot_id);

ALTER TABLE compaction_batch_marks RENAME TO compaction_batch_marks_v1;
CREATE TABLE compaction_batch_marks (
  batch_id TEXT NOT NULL,
  member_index INTEGER NOT NULL CHECK (member_index >= 0),
  mark_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  allow_delete INTEGER NOT NULL CHECK (allow_delete IN (0, 1)),
  PRIMARY KEY (batch_id, mark_id),
  UNIQUE (batch_id, member_index),
  FOREIGN KEY (batch_id) REFERENCES compaction_batches(batch_id) ON DELETE CASCADE,
  FOREIGN KEY (mark_id) REFERENCES marks(mark_id),
  FOREIGN KEY (source_snapshot_id) REFERENCES source_snapshots(snapshot_id)
);
INSERT INTO compaction_batch_marks (
  batch_id,
  member_index,
  mark_id,
  source_snapshot_id,
  allow_delete
)
SELECT
  batch_id,
  member_index,
  mark_id,
  source_snapshot_id,
  CASE route WHEN 'delete' THEN 1 ELSE 0 END
FROM compaction_batch_marks_v1;
DROP TABLE compaction_batch_marks_v1;
CREATE INDEX idx_compaction_batch_marks_mark
ON compaction_batch_marks (mark_id, batch_id);

ALTER TABLE replacements RENAME TO replacements_v1;
CREATE TABLE replacements (
  replacement_id TEXT PRIMARY KEY,
  allow_delete INTEGER NOT NULL CHECK (allow_delete IN (0, 1)),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('compact', 'delete')),
  source_snapshot_id TEXT NOT NULL,
  batch_id TEXT,
  job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('committed', 'invalidated')),
  content_text TEXT,
  content_json TEXT,
  committed_at_ms INTEGER NOT NULL,
  invalidated_at_ms INTEGER,
  invalidation_kind TEXT,
  invalidated_by_mark_id TEXT,
  metadata_json TEXT,
  FOREIGN KEY (source_snapshot_id) REFERENCES source_snapshots(snapshot_id),
  FOREIGN KEY (batch_id) REFERENCES compaction_batches(batch_id),
  FOREIGN KEY (job_id) REFERENCES compaction_jobs(job_id),
  FOREIGN KEY (invalidated_by_mark_id) REFERENCES marks(mark_id)
);
INSERT INTO replacements (
  replacement_id,
  allow_delete,
  execution_mode,
  source_snapshot_id,
  batch_id,
  job_id,
  status,
  content_text,
  content_json,
  committed_at_ms,
  invalidated_at_ms,
  invalidation_kind,
  invalidated_by_mark_id,
  metadata_json
)
SELECT
  replacement_id,
  CASE route WHEN 'delete' THEN 1 ELSE 0 END,
  CASE route WHEN 'delete' THEN 'delete' ELSE 'compact' END,
  source_snapshot_id,
  batch_id,
  job_id,
  status,
  content_text,
  content_json,
  committed_at_ms,
  invalidated_at_ms,
  invalidation_kind,
  invalidated_by_mark_id,
  metadata_json
FROM replacements_v1;
DROP TABLE replacements_v1;
CREATE INDEX idx_replacements_matchable
ON replacements (allow_delete, status, committed_at_ms);
CREATE INDEX idx_replacements_job
ON replacements (job_id);
      `);
    },
  },
]);

export function applyStateSchemaMigrations(
  database: SqliteDatabase,
  now: () => number = Date.now,
): number {
  ensureStateSchemaMigrationTable(database);
  const appliedVersion = getAppliedStateSchemaVersion(database);

  if (appliedVersion > CURRENT_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${appliedVersion} is newer than supported version ${CURRENT_STATE_SCHEMA_VERSION}.`,
    );
  }

  for (const migration of STATE_SCHEMA_MIGRATIONS) {
    if (migration.version <= appliedVersion) {
      continue;
    }

    database.exec("BEGIN");

    try {
      migration.apply(database);
      database
        .prepare(
          `INSERT INTO ${STATE_SCHEMA_MIGRATION_TABLE} (version, applied_at_ms) VALUES (:version, :appliedAtMs)`,
        )
        .run({
          version: migration.version,
          appliedAtMs: now(),
        });
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  return CURRENT_STATE_SCHEMA_VERSION;
}

export function getAppliedStateSchemaVersion(database: SqliteDatabase): number {
  ensureStateSchemaMigrationTable(database);

  const row = database
    .prepare(`SELECT MAX(version) AS version FROM ${STATE_SCHEMA_MIGRATION_TABLE}`)
    .get() as Record<string, unknown> | undefined;

  const version = row?.version;
  if (version === null || version === undefined) {
    return 0;
  }

  return readRequiredNumber(version, "state_schema_migrations.version");
}

function ensureStateSchemaMigrationTable(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${STATE_SCHEMA_MIGRATION_TABLE} (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    )
  `);
}

function hasLegacyRouteColumns(database: SqliteDatabase): boolean {
  return [
    ["source_snapshots", "route"],
    ["marks", "route"],
    ["compaction_batch_marks", "route"],
    ["replacements", "route"],
  ].some(([tableName, columnName]) => tableHasColumn(database, tableName, columnName));
}

function tableHasColumn(
  database: SqliteDatabase,
  tableName: string,
  columnName: string,
): boolean {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<Record<string, unknown>>;

  return rows.some((row) => row.name === columnName);
}

function readRequiredNumber(value: unknown, fieldName: string): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  throw new Error(`Expected numeric value for '${fieldName}'.`);
}
