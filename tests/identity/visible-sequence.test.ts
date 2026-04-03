import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeVisibleChecksum,
  ensureReferableVisibleMessageIdentity,
  ensureVisibleMessageIdentity,
} from "../../src/identity/visible-sequence.js";
import { createSqliteSessionStateStore, type SqliteSessionStateStore } from "../../src/state/store.js";

test("visible ids use the canonical identifier checksum and bare sequence format", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-1",
      syncedAtMs: clock.tick(),
      messages: [hostMessage("host-row-1", "canon-msg-1", "user")],
    });

    const visibleIdentity = ensureVisibleMessageIdentity(store, {
      hostMessageID: "host-row-1",
      canonicalMessageID: "canon-msg-1",
    });
    const expectedChecksum = computeVisibleChecksum("canon-msg-1");

    assert.deepEqual(visibleIdentity, {
      hostMessageID: "host-row-1",
      canonicalMessageID: "canon-msg-1",
      visibleSeq: 1,
      visibleChecksum: expectedChecksum,
      visibleMessageID: `000001_${expectedChecksum}`,
    });
    assert.equal(store.getHostMessage("host-row-1")?.visibleChecksum, expectedChecksum);
  });
});

test("visible sequence allocation stays permanent across deletes and reverts", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-1",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("host-1", "canon-1", "user"),
        hostMessage("host-2", "canon-2", "assistant"),
        hostMessage("host-3", "canon-3", "tool"),
      ],
    });

    const first = ensureVisibleMessageIdentity(store, {
      hostMessageID: "host-1",
      canonicalMessageID: "canon-1",
    });
    const second = ensureVisibleMessageIdentity(store, {
      hostMessageID: "host-2",
      canonicalMessageID: "canon-2",
    });
    const third = ensureVisibleMessageIdentity(store, {
      hostMessageID: "host-3",
      canonicalMessageID: "canon-3",
    });

    store.syncCanonicalHostMessages({
      revision: "rev-2",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("host-1", "canon-1", "user"),
        hostMessage("host-3", "canon-3", "tool"),
        hostMessage("host-4", "canon-4", "assistant"),
      ],
    });

    const afterDeleteFirst = ensureVisibleMessageIdentity(store, {
      hostMessageID: "host-1",
      canonicalMessageID: "canon-1",
    });
    const afterDeleteThird = ensureVisibleMessageIdentity(store, {
      hostMessageID: "host-3",
      canonicalMessageID: "canon-3",
    });
    const fourth = ensureVisibleMessageIdentity(store, {
      hostMessageID: "host-4",
      canonicalMessageID: "canon-4",
    });

    store.syncCanonicalHostMessages({
      revision: "rev-3",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("host-1", "canon-1", "user"),
        hostMessage("host-2", "canon-2", "assistant"),
        hostMessage("host-3", "canon-3", "tool"),
        hostMessage("host-4", "canon-4", "assistant"),
      ],
    });

    const afterRevertSecond = ensureVisibleMessageIdentity(store, {
      hostMessageID: "host-2",
      canonicalMessageID: "canon-2",
    });

    assert.equal(afterDeleteFirst.visibleMessageID, first.visibleMessageID);
    assert.equal(afterDeleteThird.visibleMessageID, third.visibleMessageID);
    assert.equal(fourth.visibleSeq, 4);
    assert.equal(store.getHostMessage("host-2")?.canonicalPresent, true);
    assert.equal(afterRevertSecond.visibleMessageID, second.visibleMessageID);
    assert.equal(store.getHostMessage("host-1")?.visibleSeq, 1);
    assert.equal(store.getHostMessage("host-2")?.visibleSeq, 2);
    assert.equal(store.getHostMessage("host-3")?.visibleSeq, 3);
    assert.equal(store.getHostMessage("host-4")?.visibleSeq, 4);
  });
});

test("referable blocks inherit the earliest source visible identity", async () => {
  await withTempStore(async (store, clock) => {
    store.syncCanonicalHostMessages({
      revision: "rev-ref",
      syncedAtMs: clock.tick(),
      messages: [
        hostMessage("host-2", "canon-2", "assistant"),
        hostMessage("host-3", "canon-3", "tool"),
      ],
    });

    const referableIdentity = ensureReferableVisibleMessageIdentity(store, [
      {
        hostMessageID: "host-2",
        canonicalMessageID: "canon-2",
      },
      {
        hostMessageID: "host-3",
        canonicalMessageID: "canon-3",
      },
    ]);
    const sourceIdentity = ensureVisibleMessageIdentity(store, {
      hostMessageID: "host-2",
      canonicalMessageID: "canon-2",
    });

    assert.equal(referableIdentity.visibleMessageID, sourceIdentity.visibleMessageID);
    assert.equal(referableIdentity.hostMessageID, "host-2");
    assert.equal(referableIdentity.canonicalMessageID, "canon-2");
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
  run: (store: SqliteSessionStateStore, clock: ReturnType<typeof createClock>) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(join(tmpdir(), "opencode-context-compression-identity-"));
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
