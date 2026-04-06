import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  SIDECAR_INDEX_NAMES,
  SIDECAR_SCHEMA_META,
  SIDECAR_TABLE_NAMES,
  bootstrapSessionSidecar,
} from "../../../src/state/sidecar-store.js";
import { createSqliteDatabase } from "../../../src/state/sqlite-runtime.js";
import {
  resolvePluginStateDirectory,
  resolveSessionSidecarLayout,
} from "../../../src/runtime/sidecar-layout.js";

test("bootstrap creates only Task-1 sidecar tables, locked indexes, and layout paths", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-schema-bootstrap-"),
  );

  try {
    const layout = resolveSessionSidecarLayout({
      pluginDirectory,
      sessionID: "session-bootstrap",
      runtimeLogPath: "logs/runtime-events.jsonl",
      seamLogPath: "logs/seam-observation.jsonl",
      debugSnapshotPath: "state/debug",
    });

    assert.equal(
      layout.databasePath,
      resolve(pluginDirectory, "state/session-bootstrap.db"),
    );
    assert.equal(
      layout.lockPath,
      resolve(pluginDirectory, "locks/session-bootstrap.lock"),
    );
    assert.equal(
      layout.seamLogPath,
      resolve(pluginDirectory, "logs/seam-observation.jsonl"),
    );
    assert.equal(
      layout.debugSnapshotInputPath,
      resolve(pluginDirectory, "state/debug/session-bootstrap.in.json"),
    );
    assert.equal(
      layout.debugSnapshotOutputPath,
      resolve(pluginDirectory, "state/debug/session-bootstrap.out.json"),
    );

    await bootstrapSessionSidecar({
      databasePath: layout.databasePath,
    });

    const rawDatabase = createSqliteDatabase(layout.databasePath, {
      enableForeignKeyConstraints: true,
    });

    try {
      const tableRows = rawDatabase
        .prepare<{ readonly name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`,
        )
        .all();
      const indexRows = rawDatabase
        .prepare<{ readonly name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`,
        )
        .all();
      const schemaMetaRows = rawDatabase
        .prepare<{ readonly key: string; readonly value: string }>(
          `SELECT key, value FROM schema_meta ORDER BY key ASC`,
        )
        .all();
      const visibleColumns = rawDatabase
        .prepare<{ readonly name: string }>(
          `PRAGMA table_info(visible_sequence_allocations)`,
        )
        .all();

      assert.deepEqual(
        tableRows.map((row) => row.name),
        [...SIDECAR_TABLE_NAMES].sort(),
      );
      assert.deepEqual(
        indexRows.map((row) => row.name),
        [...SIDECAR_INDEX_NAMES].sort(),
      );
      assert.deepEqual(
        schemaMetaRows.map((row) => ({ key: row.key, value: row.value })),
        [
          { key: "schema_version", value: SIDECAR_SCHEMA_META.schema_version },
          { key: "truth_model", value: SIDECAR_SCHEMA_META.truth_model },
        ],
      );
      assert.deepEqual(
        visibleColumns.map((row) => row.name),
        [
          "canonical_id",
          "visible_seq",
          "visible_kind",
          "visible_base62",
          "assigned_visible_id",
          "allocated_at",
        ],
      );

      const rootEntries = (await readdir(pluginDirectory)).sort();
      assert.deepEqual(rootEntries, ["state"]);

      const stateDirectoryEntries = await readdir(
        resolvePluginStateDirectory(pluginDirectory),
      );
      assert.deepEqual(stateDirectoryEntries.sort(), [
        "session-bootstrap.db",
        "session-bootstrap.db-shm",
        "session-bootstrap.db-wal",
      ]);
    } finally {
      rawDatabase.close();
    }
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});

test("bootstrap deletes legacy truth tables and incompatible remnants instead of preserving them", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-schema-cutover-"),
  );

  try {
    const stateDirectory = resolvePluginStateDirectory(pluginDirectory);
    await mkdir(stateDirectory, { recursive: true });
    const databasePath = join(stateDirectory, "session-cutover.db");
    const seededDatabase = createSqliteDatabase(databasePath, {
      enableForeignKeyConstraints: true,
    });

    try {
      seededDatabase.exec(`
        CREATE TABLE marks (
          mark_id TEXT PRIMARY KEY
        );

        CREATE TABLE source_snapshots (
          snapshot_id TEXT PRIMARY KEY
        );

        CREATE TABLE canonical_sources (
          canonical_id TEXT PRIMARY KEY
        );

        CREATE TABLE runtime_gate_audit (
          observed_state TEXT NOT NULL
        );

        CREATE TABLE result_fragments (
          mark_id TEXT NOT NULL,
          fragment_index INTEGER NOT NULL,
          fragment_kind TEXT NOT NULL,
          replacement_text TEXT NOT NULL,
          PRIMARY KEY (mark_id, fragment_index)
        );
      `);
    } finally {
      seededDatabase.close();
    }

    await bootstrapSessionSidecar({ databasePath });

    const rawDatabase = createSqliteDatabase(databasePath, {
      enableForeignKeyConstraints: true,
    });

    try {
      const tableRows = rawDatabase
        .prepare<{ readonly name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`,
        )
        .all();
      const visibleColumns = rawDatabase
        .prepare<{ readonly name: string }>(
          `PRAGMA table_info(visible_sequence_allocations)`,
        )
        .all();
      const fragmentColumns = rawDatabase
        .prepare<{ readonly name: string }>(
          `PRAGMA table_info(result_fragments)`,
        )
        .all();

      assert.deepEqual(
        tableRows.map((row) => row.name),
        [...SIDECAR_TABLE_NAMES].sort(),
      );
      assert.deepEqual(
        visibleColumns.map((row) => row.name),
        [
          "canonical_id",
          "visible_seq",
          "visible_kind",
          "visible_base62",
          "assigned_visible_id",
          "allocated_at",
        ],
      );
      assert.deepEqual(
        fragmentColumns.map((row) => row.name),
        [
          "mark_id",
          "fragment_index",
          "source_start_seq",
          "source_end_seq",
          "replacement_text",
        ],
      );
    } finally {
      rawDatabase.close();
    }
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});
