import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openSessionSidecarRepository,
  type SessionSidecarResultGroupWrite,
} from "../../../src/state/sidecar-store.js";

test("visible-id allocation is stable and result-group upsert is idempotent per mark id", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-result-group-idempotency-"),
  );
  const databasePath = join(pluginDirectory, "state", "session-idempotency.db");
  const repository = await openSessionSidecarRepository({ databasePath });

  try {
    const firstVisibleAllocation = repository.allocateVisibleID({
      canonicalID: "msg-user-1",
      visibleKind: "protected",
      allocatedAt: "2026-04-06T11:00:00.000Z",
    });
    const repeatedVisibleAllocation = repository.allocateVisibleID({
      canonicalID: "msg-user-1",
      visibleKind: "protected",
      allocatedAt: "2026-04-06T11:00:01.000Z",
    });
    const secondVisibleAllocation = repository.allocateVisibleID({
      canonicalID: "msg-assistant-2",
      visibleKind: "compressible",
      allocatedAt: "2026-04-06T11:00:02.000Z",
    });

    assert.deepEqual(repeatedVisibleAllocation, firstVisibleAllocation);
    assert.equal(firstVisibleAllocation.visibleSeq, 1);
    assert.match(
      firstVisibleAllocation.assignedVisibleID,
      /^protected_000001_[0-9A-Za-z]{8}$/,
    );
    assert.equal(secondVisibleAllocation.visibleSeq, 2);
    assert.match(
      secondVisibleAllocation.assignedVisibleID,
      /^compressible_000002_[0-9A-Za-z]{8}$/,
    );

    const write: SessionSidecarResultGroupWrite = {
      markID: "mark-idempotent-1",
      mode: "delete",
      sourceStartSeq: 21,
      sourceEndSeq: 24,
      modelName: "gpt-test-mini",
      executionMode: "foreground",
      createdAt: "2026-04-06T11:01:00.000Z",
      committedAt: "2026-04-06T11:01:04.000Z",
      fragments: [
        {
          sourceStartSeq: 21,
          sourceEndSeq: 24,
          replacementText: "[deleted span notice]",
        },
      ],
    };

    const inserted = repository.upsertResultGroup(write);
    const unchanged = repository.upsertResultGroup(write);

    assert.equal(inserted.status, "inserted");
    assert.equal(unchanged.status, "unchanged");
    assert.deepEqual(unchanged.resultGroup, inserted.resultGroup);
    assert.deepEqual(
      repository.getResultGroupByMarkID("mark-idempotent-1"),
      inserted.resultGroup,
    );
    assert.deepEqual(repository.readResultGroup("mark-idempotent-1"), inserted.resultGroup);
    assert.deepEqual(repository.listResultGroups(), [inserted.resultGroup]);
    assert.deepEqual(repository.listVisibleIDs(), [
      firstVisibleAllocation,
      secondVisibleAllocation,
    ]);

    assert.throws(
      () => {
        repository.upsertResultGroup({
          ...write,
          fragments: [
            {
              sourceStartSeq: 21,
              sourceEndSeq: 24,
              replacementText: "[different delete notice]",
            },
          ],
        });
      },
      /already exists with different content/i,
    );

    assert.deepEqual(
      repository.readResultGroup("mark-idempotent-1"),
      inserted.resultGroup,
    );
  } finally {
    repository.close();
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});
