import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureMarkSourceSnapshot,
  persistMark,
} from "../../src/marks/mark-service.js";
import {
  createSqliteSessionStateStore,
  type SqliteSessionStateStore,
} from "../../src/state/store.js";

test("persistMark captures an ordered canonical source snapshot and carries allowDelete with the durable mark", async () => {
  await withTempStore(async (store, clock) => {
    assert.equal(store.getSchemaVersion(), 5);
    store.syncCanonicalHostMessages({
      revision: "rev-mark-1",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-1", "canon-src-1", "assistant"),
        hostMessage("src-2", "canon-src-2", "tool"),
        hostMessage("src-3", "canon-src-3", "tool"),
        hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
      ],
    });

    const persisted = persistMark({
      store,
      markID: "mark-delete-1",
      toolCallMessageID: "mark-tool-1",
      allowDelete: true,
      markLabel: "b~d",
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "src-2", contentHash: "hash-src-2" },
        { hostMessageID: "src-1" },
        { hostMessageID: "src-3", metadata: { step: 3 } },
      ],
      snapshotMetadata: { capturedBy: "mark-service" },
    });

    const storedSnapshot = store.getSourceSnapshot(
      persisted.mark.sourceSnapshotID,
    );
    assert.ok(storedSnapshot);
    assert.equal(persisted.mark.allowDelete, true);
    assert.equal(storedSnapshot?.allowDelete, true);
    assert.equal(storedSnapshot?.canonicalRevision, "rev-mark-1");
    assert.equal(storedSnapshot?.snapshotKind, "mark");
    assert.deepEqual(storedSnapshot?.metadata, { capturedBy: "mark-service" });
    assert.deepEqual(
      persisted.sourceSnapshot.messages.map((message) => ({
        hostMessageID: message.hostMessageID,
        canonicalMessageID: message.canonicalMessageID,
        role: message.role,
      })),
      [
        {
          hostMessageID: "src-2",
          canonicalMessageID: "canon-src-2",
          role: "tool",
        },
        {
          hostMessageID: "src-1",
          canonicalMessageID: "canon-src-1",
          role: "assistant",
        },
        {
          hostMessageID: "src-3",
          canonicalMessageID: "canon-src-3",
          role: "tool",
        },
      ],
    );
    assert.deepEqual(
      store
        .listSourceSnapshotMessages(persisted.mark.sourceSnapshotID)
        .map((message) => ({
          hostMessageID: message.hostMessageID,
          canonicalMessageID: message.canonicalMessageID,
          hostRole: message.hostRole,
          contentHash: message.contentHash,
          metadata: message.metadata,
        })),
      [
        {
          hostMessageID: "src-2",
          canonicalMessageID: "canon-src-2",
          hostRole: "tool",
          contentHash: "hash-src-2",
          metadata: undefined,
        },
        {
          hostMessageID: "src-1",
          canonicalMessageID: "canon-src-1",
          hostRole: "assistant",
          contentHash: undefined,
          metadata: undefined,
        },
        {
          hostMessageID: "src-3",
          canonicalMessageID: "canon-src-3",
          hostRole: "tool",
          contentHash: undefined,
          metadata: { step: 3 },
        },
      ],
    );
    assert.equal(
      store.getMarkByToolCallMessageID("mark-tool-1")?.markID,
      persisted.mark.markID,
    );
    assert.equal(store.listMarks({ status: "active" }).length, 1);
  });
});

test("commitReplacement persists a complete mark-id keyed result group and legacy replacement compatibility rows atomically", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-group-1",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-1", "canon-src-1", "assistant"),
        hostMessage("src-2", "canon-src-2", "tool"),
        hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
      ],
    });

    persistMark({
      store,
      markID: "mark-1",
      toolCallMessageID: "mark-tool-1",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "src-1" }, { hostMessageID: "src-2" }],
    });

    const replacement = store.commitReplacement({
      replacementID: "replacement-1",
      allowDelete: false,
      executionMode: "compact",
      committedAtMs: clock.tick(),
      contentText: "Compressed summary.",
      markIDs: ["mark-1"],
      sourceSnapshot: {
        messages: [
          { hostMessageID: "src-1", role: "assistant" },
          { hostMessageID: "src-2", role: "tool" },
        ],
      },
    });

    const resultGroup = store.getReplacementResultGroup("mark-1");
    assert.ok(resultGroup);
    assert.equal(resultGroup?.primaryMarkID, "mark-1");
    assert.equal(resultGroup?.completeness, "complete");
    assert.equal(resultGroup?.itemCount, 1);
    assert.deepEqual(store.listReplacementResultGroupItems("mark-1"), [
      {
        resultGroupID: "replacement-1",
        itemIndex: 0,
        replacementID: "replacement-1",
        sourceSnapshotID: replacement.sourceSnapshotID,
        contentText: "Compressed summary.",
        contentJSON: undefined,
        metadata: undefined,
      },
    ]);
    assert.deepEqual(
      store.listReplacementResultGroupMarkLinks("mark-1").map((link) => [link.markID, link.linkKind]),
      [["mark-1", "primary"]],
    );
    assert.equal(store.findLatestCommittedReplacementForMark("mark-1")?.replacementID, "replacement-1");
    assert.equal(store.getMark("mark-1")?.status, "consumed");
  });
});

test("result groups stay absent when only incomplete compatibility rows exist", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-group-2",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-1", "canon-src-1", "assistant"),
        hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
      ],
    });

    persistMark({
      store,
      markID: "mark-2",
      toolCallMessageID: "mark-tool-1",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "src-1" }],
    });

    store.commitReplacementResultGroup({
      primaryMarkID: "mark-2",
      executionMode: "compact",
      committedAtMs: clock.tick(),
      items: [
        {
          sourceSnapshot: {
            messages: [{ hostMessageID: "src-1", role: "assistant" }],
          },
          contentText: "summary only in group",
        },
      ],
    });

    assert.equal(store.getReplacementResultGroup("mark-2")?.completeness, "complete");
    assert.equal(store.findLatestCommittedReplacementForMark("mark-2"), undefined);
  });
});

test("captureMarkSourceSnapshot rejects source ids that do not match synced canonical host state", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-mark-2",
      syncedAtMs: clock.tick(),
      messages: [hostMessage("src-1", "canon-src-1", "assistant")],
    });

    assert.throws(
      () =>
        captureMarkSourceSnapshot({
          store,
          allowDelete: false,
          sourceMessages: [
            {
              hostMessageID: "src-1",
              canonicalMessageID: "wrong-canonical-id",
            },
          ],
        }),
      /Mark source canonical id mismatch/,
    );
  });
});

function hostMessage(
  hostMessageID: string,
  canonicalMessageID: string,
  role: string,
) {
  return {
    hostMessageID,
    canonicalMessageID,
    role,
  };
}

async function withTempStore(
  run: (
    store: SqliteSessionStateStore,
    clock: ReturnType<typeof createClock>,
  ) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-mark-persistence-"),
  );
  const clock = createClock();
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "test-session",
    now: () => clock.current,
  });

  try {
    await run(store, clock);
  } finally {
    store.close();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}

function createClock() {
  let current = 0;

  return {
    get current() {
      return current;
    },
    tick() {
      current += 1;
      return current;
    },
  };
}
