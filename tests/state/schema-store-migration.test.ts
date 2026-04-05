import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteSessionStateStore } from "../../src/state/store.js";
import { createSqliteDatabase } from "../../src/state/sqlite-runtime.js";

test("schema migration projects legacy marks and replacements into runtime/result-group tables", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-schema-migration-"),
  );
  const stateDirectory = join(pluginDirectory, "state");
  const databasePath = join(stateDirectory, "test-session.db");

  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(stateDirectory, { recursive: true }));
    const database = createSqliteDatabase(databasePath, {
      enableForeignKeyConstraints: true,
    });

    try {
      database.exec(`
CREATE TABLE state_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);
INSERT INTO state_schema_migrations (version, applied_at_ms) VALUES (2, 1);

CREATE TABLE session_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_canonical_revision TEXT,
  last_synced_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);
INSERT INTO session_state (id, updated_at_ms) VALUES (1, 1);

CREATE TABLE host_messages (
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

CREATE TABLE visible_sequence_state (
  allocator_name TEXT PRIMARY KEY CHECK (allocator_name = 'default'),
  next_seq INTEGER NOT NULL CHECK (next_seq >= 1),
  updated_at_ms INTEGER NOT NULL
);
INSERT INTO visible_sequence_state (allocator_name, next_seq, updated_at_ms)
VALUES ('default', 1, 0);

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

CREATE TABLE source_snapshot_messages (
  snapshot_id TEXT NOT NULL,
  source_index INTEGER NOT NULL CHECK (source_index >= 0),
  host_message_id TEXT NOT NULL,
  canonical_message_id TEXT NOT NULL,
  host_role TEXT NOT NULL,
  content_hash TEXT,
  metadata_json TEXT,
  PRIMARY KEY (snapshot_id, source_index)
);

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
  metadata_json TEXT
);

CREATE TABLE compaction_batches (
  batch_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('frozen', 'running', 'succeeded', 'failed', 'cancelled')),
  frozen_at_ms INTEGER NOT NULL,
  canonical_revision TEXT,
  metadata_json TEXT
);

CREATE TABLE compaction_batch_marks (
  batch_id TEXT NOT NULL,
  member_index INTEGER NOT NULL CHECK (member_index >= 0),
  mark_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  allow_delete INTEGER NOT NULL CHECK (allow_delete IN (0, 1)),
  PRIMARY KEY (batch_id, mark_id)
);

CREATE TABLE compaction_jobs (
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
  metadata_json TEXT
);

CREATE TABLE compaction_job_attempts (
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
  PRIMARY KEY (job_id, attempt_index)
);

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
  metadata_json TEXT
);

CREATE TABLE replacement_mark_links (
  replacement_id TEXT NOT NULL,
  mark_id TEXT NOT NULL,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('consumed')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (replacement_id, mark_id)
);

CREATE TABLE runtime_gate_audit (
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

INSERT INTO host_messages (
  host_message_id,
  canonical_message_id,
  role,
  canonical_present,
  first_seen_at_ms,
  last_seen_at_ms,
  updated_at_ms
) VALUES
  ('src-1', 'canon-src-1', 'assistant', 1, 1, 1, 1),
  ('mark-tool-1', 'canon-mark-tool-1', 'tool', 1, 1, 1, 1);

INSERT INTO source_snapshots (
  snapshot_id,
  snapshot_kind,
  allow_delete,
  source_fingerprint,
  canonical_revision,
  source_count,
  created_at_ms,
  metadata_json
) VALUES
  ('mark-1:snapshot', 'mark', 0, 'fp-1', 'rev-1', 1, 2, NULL),
  ('replacement-1:snapshot', 'replacement', 0, 'fp-1', 'rev-1', 1, 3, NULL);

INSERT INTO source_snapshot_messages (
  snapshot_id,
  source_index,
  host_message_id,
  canonical_message_id,
  host_role
) VALUES
  ('mark-1:snapshot', 0, 'src-1', 'canon-src-1', 'assistant'),
  ('replacement-1:snapshot', 0, 'src-1', 'canon-src-1', 'assistant');

INSERT INTO marks (
  mark_id,
  tool_call_message_id,
  allow_delete,
  source_snapshot_id,
  status,
  created_at_ms,
  consumed_at_ms
) VALUES ('mark-1', 'mark-tool-1', 0, 'mark-1:snapshot', 'consumed', 2, 4);

INSERT INTO replacements (
  replacement_id,
  allow_delete,
  execution_mode,
  source_snapshot_id,
  status,
  content_text,
  committed_at_ms
) VALUES ('replacement-1', 0, 'compact', 'replacement-1:snapshot', 'committed', 'legacy summary', 4);

INSERT INTO host_messages (
  host_message_id,
  canonical_message_id,
  role,
  canonical_present,
  first_seen_at_ms,
  last_seen_at_ms,
  updated_at_ms
) VALUES ('mark-tool-2', 'canon-mark-tool-2', 'tool', 1, 1, 1, 1);

INSERT INTO marks (
  mark_id,
  tool_call_message_id,
  allow_delete,
  source_snapshot_id,
  status,
  created_at_ms,
  consumed_at_ms
) VALUES ('mark-2', 'mark-tool-2', 0, 'mark-1:snapshot', 'consumed', 3, 4);

INSERT INTO replacement_mark_links (
  replacement_id,
  mark_id,
  link_kind,
  created_at_ms
) VALUES
  ('replacement-1', 'mark-1', 'consumed', 4),
  ('replacement-1', 'mark-2', 'consumed', 5);
      `);
    } finally {
      database.close();
    }

    const store = createSqliteSessionStateStore({
      pluginDirectory,
      sessionID: "test-session",
    });

    try {
      assert.equal(store.getSchemaVersion(), 5);
      assert.equal(store.getMark("mark-1")?.status, "consumed");
      assert.equal(store.getMark("mark-2")?.status, "consumed");
      assert.equal(store.getReplacementResultGroup("mark-1")?.resultGroupID, "replacement-1");
      assert.equal(store.getReplacementResultGroup("mark-2")?.resultGroupID, "replacement-1");
      assert.equal(store.getReplacementResultGroup("mark-1")?.completeness, "complete");
      assert.deepEqual(
        store.listReplacementResultGroupMarkLinks("mark-2").map((link) => [link.markID, link.linkKind]),
        [
          ["mark-1", "primary"],
          ["mark-2", "consumed"],
        ],
      );
      assert.equal(
        store.findLatestCommittedReplacementForMark("mark-1")?.contentText,
        "legacy summary",
      );
      assert.equal(
        store.findLatestCommittedReplacementForMark("mark-2")?.contentText,
        "legacy summary",
      );
      assert.equal(store.getReplacement("replacement-1")?.contentText, "legacy summary");
    } finally {
      store.close();
    }
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});
