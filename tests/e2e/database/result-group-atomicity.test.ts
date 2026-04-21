import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openSessionSidecarRepository,
} from "../../../src/state/sidecar-store.js";
import { createSqliteDatabase } from "../../../src/state/sqlite-runtime.js";
import {
  resolvePluginStateDirectory,
} from "../../../src/runtime/sidecar-layout.js";

test("result-group creation is atomic and failed multi-fragment writes stay fully invisible", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-result-group-atomicity-"),
  );
  const databasePath = join(
    resolvePluginStateDirectory(pluginDirectory),
    "session-atomicity.db",
  );
  const repository = await openSessionSidecarRepository({ databasePath });

  try {
    assert.throws(
      () => {
        repository.createResultGroup({
          markID: "mark-atomicity-1",
          mode: "compact",
          sourceStartSeq: 10,
          sourceEndSeq: 14,
          modelName: "gpt-test-mini",
          executionMode: "background",
          createdAt: "2026-04-06T10:00:00.000Z",
          committedAt: "2026-04-06T10:00:05.000Z",
          fragments: [
            {
              sourceStartSeq: 10,
              sourceEndSeq: 11,
              replacementText: "Leading summary fragment",
            },
            {
              sourceStartSeq: 13,
              sourceEndSeq: 14,
              replacementText: undefined as unknown as string,
            },
          ],
        });
      },
      /cannot be bound|NOT NULL|replacement_text|constraint/i,
    );

    assert.equal(repository.readResultGroup("mark-atomicity-1"), undefined);
    assert.equal(repository.getResultGroupByMarkID("mark-atomicity-1"), undefined);

    const database = createSqliteDatabase(databasePath, {
      enableForeignKeyConstraints: true,
    });

    try {
      const groupCount = database
        .prepare<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM result_groups WHERE mark_id = :mark_id`,
        )
        .get({ mark_id: "mark-atomicity-1" });
      const fragmentCount = database
        .prepare<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM result_fragments WHERE mark_id = :mark_id`,
        )
        .get({ mark_id: "mark-atomicity-1" });

      assert.equal(groupCount?.count ?? 0, 0);
      assert.equal(fragmentCount?.count ?? 0, 0);
    } finally {
      database.close();
    }

    const committed = repository.createResultGroup({
      markID: "mark-atomicity-1",
      mode: "compact",
      sourceStartSeq: 10,
      sourceEndSeq: 14,
      modelName: "gpt-test-mini",
      executionMode: "background",
      createdAt: "2026-04-06T10:01:00.000Z",
      committedAt: "2026-04-06T10:01:05.000Z",
      fragments: [
        {
          sourceStartSeq: 10,
          sourceEndSeq: 11,
          replacementText: "Leading summary fragment",
        },
        {
          sourceStartSeq: 13,
          sourceEndSeq: 14,
          replacementText: "Trailing summary fragment",
        },
      ],
    });

    assert.equal(committed.markID, "mark-atomicity-1");
    assert.equal(committed.fragmentCount, 2);
    assert.deepEqual(
      committed.fragments.map((fragment) => fragment.fragmentIndex),
      [0, 1],
    );
  } finally {
    repository.close();
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});
