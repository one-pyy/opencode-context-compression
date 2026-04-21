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

test("read-model returns complete ordered fragments and lists committed groups by source range", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-result-group-read-model-"),
  );
  const databasePath = join(
    resolvePluginStateDirectory(pluginDirectory),
    "session-read-model.db",
  );
  const repository = await openSessionSidecarRepository({ databasePath });

  try {
    const laterGroup = repository.createResultGroup({
      markID: "mark-read-2",
      mode: "compact",
      sourceStartSeq: 40,
      sourceEndSeq: 42,
      modelName: "gpt-test-mini",
      executionMode: "background",
      createdAt: "2026-04-06T12:00:10.000Z",
      committedAt: "2026-04-06T12:00:12.000Z",
      fragments: [
        {
          sourceStartSeq: 40,
          sourceEndSeq: 42,
          replacementText: "Later compacted span",
        },
      ],
    });
    const earlierGroup = repository.createResultGroup({
      markID: "mark-read-1",
      mode: "compact",
      sourceStartSeq: 30,
      sourceEndSeq: 35,
      modelName: "gpt-test-mini",
      executionMode: "background",
      createdAt: "2026-04-06T12:00:00.000Z",
      committedAt: "2026-04-06T12:00:05.000Z",
      fragments: [
        {
          sourceStartSeq: 30,
          sourceEndSeq: 31,
          replacementText: "Opening fragment",
        },
        {
          sourceStartSeq: 34,
          sourceEndSeq: 35,
          replacementText: "Closing fragment",
        },
      ],
    });

    assert.deepEqual(repository.readResultGroup("mark-read-1"), earlierGroup);
    assert.deepEqual(repository.getResultGroupByMarkID("mark-read-1"), earlierGroup);
    assert.deepEqual(repository.listResultGroups(), [earlierGroup, laterGroup]);
    assert.deepEqual(
      earlierGroup.fragments.map((fragment) => fragment.fragmentIndex),
      [0, 1],
    );
  } finally {
    repository.close();
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});

test("read-model fails fast when persisted fragment completeness or order is corrupted", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-result-group-corruption-"),
  );
  const databasePath = join(
    resolvePluginStateDirectory(pluginDirectory),
    "session-read-model-corrupt.db",
  );

  try {
    const repository = await openSessionSidecarRepository({ databasePath });

    repository.createResultGroup({
      markID: "mark-corrupt-1",
      mode: "compact",
      sourceStartSeq: 50,
      sourceEndSeq: 56,
      modelName: "gpt-test-mini",
      executionMode: "background",
      createdAt: "2026-04-06T12:05:00.000Z",
      committedAt: "2026-04-06T12:05:05.000Z",
      fragments: [
        {
          sourceStartSeq: 50,
          sourceEndSeq: 51,
          replacementText: "First fragment",
        },
        {
          sourceStartSeq: 55,
          sourceEndSeq: 56,
          replacementText: "Second fragment",
        },
      ],
    });
    repository.close();

    const database = createSqliteDatabase(databasePath, {
      enableForeignKeyConstraints: true,
    });

    try {
      database
        .prepare(
          `DELETE FROM result_fragments WHERE mark_id = :mark_id AND fragment_index = 1`,
        )
        .run({ mark_id: "mark-corrupt-1" });
    } finally {
      database.close();
    }

    const incompleteRepository = await openSessionSidecarRepository({ databasePath });
    assert.throws(
      () => incompleteRepository.readResultGroup("mark-corrupt-1"),
      /expected 2 fragments, found 1/i,
    );
    assert.throws(
      () => incompleteRepository.listResultGroups(),
      /expected 2 fragments, found 1/i,
    );
    incompleteRepository.close();

    const repairedRepository = await openSessionSidecarRepository({ databasePath });
    repairedRepository.upsertResultGroup({
      markID: "mark-corrupt-2",
      mode: "compact",
      sourceStartSeq: 60,
      sourceEndSeq: 66,
      modelName: "gpt-test-mini",
      executionMode: "background",
      createdAt: "2026-04-06T12:06:00.000Z",
      committedAt: "2026-04-06T12:06:05.000Z",
      fragments: [
        {
          sourceStartSeq: 60,
          sourceEndSeq: 61,
          replacementText: "First fragment",
        },
        {
          sourceStartSeq: 65,
          sourceEndSeq: 66,
          replacementText: "Second fragment",
        },
      ],
    });
    repairedRepository.close();

    const databaseWithGap = createSqliteDatabase(databasePath, {
      enableForeignKeyConstraints: true,
    });

    try {
      databaseWithGap
        .prepare(
          `UPDATE result_fragments SET fragment_index = 3 WHERE mark_id = :mark_id AND fragment_index = 1`,
        )
        .run({ mark_id: "mark-corrupt-2" });
    } finally {
      databaseWithGap.close();
    }

    const gapRepository = await openSessionSidecarRepository({ databasePath });
    assert.throws(
      () => gapRepository.readResultGroup("mark-corrupt-2"),
      /expected fragment index 1, found 3/i,
    );
    gapRepository.close();
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});
