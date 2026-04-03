import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCompactionInput,
  revalidateCompactionSourceIdentity,
  resolveCompactionSourceSnapshot,
} from "../../src/compaction/input-builder.js";
import { persistMark } from "../../src/marks/mark-service.js";
import { createSqliteSessionStateStore, type SqliteSessionStateStore } from "../../src/state/store.js";

test("buildCompactionInput follows canonical source snapshot ordering and ignores unrelated prompt artifacts", async () => {
  await withTempStore(async ({ store, clock }) => {
    store.syncCanonicalHostMessages({
      revision: "rev-compaction-input-1",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-a", "canon-a", "assistant"),
        hostMessage("src-b", "canon-b", "tool"),
        hostMessage("src-c", "canon-c", "assistant"),
        hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
      ],
    });

    persistMark({
      store,
      markID: "mark-1",
      toolCallMessageID: "mark-tool-1",
      route: "keep",
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "src-b" }, { hostMessageID: "src-a" }],
    });

    const sourceSnapshot = resolveCompactionSourceSnapshot(store, "mark-1:snapshot");
    const input = buildCompactionInput({
      sourceSnapshot,
      promptText: "Summarize this canonical source span.",
      canonicalMessages: [
        {
          hostMessageID: "src-a",
          canonicalMessageID: "canon-a",
          role: "assistant",
          content: "Assistant source content.",
        },
        {
          hostMessageID: "src-c",
          canonicalMessageID: "canon-c",
          role: "assistant",
          content: "Projected reminder artifact that must not enter compaction.",
        },
        {
          hostMessageID: "src-b",
          canonicalMessageID: "canon-b",
          role: "tool",
          content: "Tool output source content.",
        },
      ],
      metadata: { origin: "test" },
    });

    assert.equal(input.kind, "canonical-source-compaction");
    assert.equal(input.promptContext, "dedicated-compaction-prompt");
    assert.equal(input.route, "keep");
    assert.deepEqual(
      input.sourceMessages.map((message) => message.hostMessageID),
      ["src-b", "src-a"],
    );
    assert.match(input.transcript, /### 1\. tool src-b \(canon-b\)/);
    assert.match(input.transcript, /### 2\. assistant src-a \(canon-a\)/);
    assert.ok(!input.transcript.includes("Projected reminder artifact"));
    assert.deepEqual(input.metadata, { origin: "test" });
  });
});

test("revalidateCompactionSourceIdentity fails when the live canonical source no longer matches the stored snapshot", async () => {
  await withTempStore(async ({ store, clock }) => {
    store.syncCanonicalHostMessages({
      revision: "rev-compaction-input-2",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-a", "canon-a", "assistant"),
        hostMessage("src-b", "canon-b", "tool"),
        hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
      ],
    });

    persistMark({
      store,
      markID: "mark-2",
      toolCallMessageID: "mark-tool-1",
      route: "delete",
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "src-a" }, { hostMessageID: "src-b" }],
    });

    store.syncCanonicalHostMessages({
      revision: "rev-compaction-input-3",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("src-a", "canon-a", "assistant"),
        hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
      ],
    });

    const validation = revalidateCompactionSourceIdentity(store, "mark-2:snapshot");
    assert.equal(validation.matches, false);
    if (validation.matches) {
      assert.fail("expected the live canonical source to fail revalidation");
    }

    assert.equal(validation.failure.code, "source-no-longer-canonical");
    assert.equal(validation.failure.hostMessageID, "src-b");
  });
});

function hostMessage(hostMessageID: string, canonicalMessageID: string, role: string) {
  return {
    hostMessageID,
    canonicalMessageID,
    role,
  };
}

async function withTempStore(
  run: (context: {
    store: SqliteSessionStateStore;
    clock: ReturnType<typeof createClock>;
  }) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(join(tmpdir(), "opencode-context-compression-compaction-input-"));
  const clock = createClock();
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "test-session",
    now: () => clock.current,
  });

  try {
    await run({ store, clock });
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
