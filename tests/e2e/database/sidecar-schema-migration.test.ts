import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bootstrapSessionSidecar, openSessionSidecarRepository } from "../../../src/state/sidecar-store.js";
import { createSqliteDatabase } from "../../../src/state/sqlite-runtime.js";

test("sidecar bootstrap drops legacy pending queue without clearing committed result data", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-sidecar-schema-"),
  );
  const databasePath = join(pluginDirectory, "session-schema-migration.db");

  try {
    const repository = await openSessionSidecarRepository({ databasePath });
    repository.createResultGroup({
      markID: "mark-schema-1",
      mode: "compact",
      sourceStartSeq: 2,
      sourceEndSeq: 8,
      modelName: "gpt-test-mini",
      executionMode: "background",
      createdAt: "2026-07-05T00:00:00.000Z",
      committedAt: "2026-07-05T00:00:05.000Z",
      fragments: [
        {
          sourceStartSeq: 2,
          sourceEndSeq: 8,
          replacementText: "Compacted result survives legacy table cleanup.",
        },
      ],
    });
    repository.close();

    const database = createSqliteDatabase(databasePath, {
      enableForeignKeyConstraints: true,
    });
    try {
      database.exec(`
        CREATE TABLE pending_compactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mark_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          processed INTEGER DEFAULT 0
        );
        INSERT INTO pending_compactions (mark_id, created_at, processed)
        VALUES ('mark-schema-1', '2026-07-05T00:00:06.000Z', 1);
      `);
    } finally {
      database.close();
    }

    await bootstrapSessionSidecar({ databasePath });

    const migrated = createSqliteDatabase(databasePath, {
      enableForeignKeyConstraints: true,
    });
    try {
      const legacyTable = migrated
        .prepare<{ readonly name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_compactions'`,
        )
        .get();
      const groupCount = migrated
        .prepare<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM result_groups`,
        )
        .get();
      const fragmentCount = migrated
        .prepare<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM result_fragments`,
        )
        .get();

      assert.equal(legacyTable, undefined);
      assert.equal(groupCount?.count, 1);
      assert.equal(fragmentCount?.count, 1);
    } finally {
      migrated.close();
    }

    const migratedRepository = await openSessionSidecarRepository({ databasePath });
    try {
      assert.equal(
        migratedRepository.readResultGroup("mark-schema-1")?.fragments[0]?.replacementText,
        "Compacted result survives legacy table cleanup.",
      );
    } finally {
      migratedRepository.close();
    }
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});
