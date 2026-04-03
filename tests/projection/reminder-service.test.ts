import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildProjectionPolicy } from "../../src/projection/policy-engine.js";
import { deriveReminder } from "../../src/projection/reminder-service.js";
import { createSqliteSessionStateStore, type SqliteSessionStateStore } from "../../src/state/store.js";
import type { TransformEnvelope, TransformMessage, TransformPart } from "../../src/seams/noop-observation.js";
import { computeVisibleChecksum } from "../../src/identity/visible-sequence.js";

test("reminder service derives a stable hard reminder from canonical history without persisting artifacts", async () => {
  await withTempStore(async (store) => {
    const messages = [
      createEnvelope(createMessage("user-1", "user", 1), [createTextPart("user-1", "u1")]),
      createEnvelope(createMessage("assistant-1", "assistant", 2), [createTextPart("assistant-1", "a1")]),
      createEnvelope(createMessage("tool-1", "tool", 3), [createTextPart("tool-1", "t1")]),
      createEnvelope(createMessage("assistant-2", "assistant", 4), [createTextPart("assistant-2", "a2")]),
      createEnvelope(createMessage("user-2", "user", 5), [createTextPart("user-2", "u2")]),
    ];

    store.syncCanonicalHostMessages({
      revision: "rev-reminder-1",
      syncedAtMs: 1,
      messages: messages.map((message) => ({
        hostMessageID: message.info.id,
        canonicalMessageID: message.info.id,
        role: message.info.role,
      })),
    });

    const policy = buildProjectionPolicy({ messages, store });
    const first = deriveReminder({
      policy,
      cadence: {
        softMessageCount: 3,
        hardMessageCount: 4,
      },
    });
    const second = deriveReminder({
      policy,
      cadence: {
        softMessageCount: 3,
        hardMessageCount: 4,
      },
    });

    assert.deepEqual(first, second);
    assert.deepEqual(first, {
      severity: "hard",
      anchorHostMessageID: "user-2",
      anchorVisibleMessageID: `000005_${computeVisibleChecksum("user-2")}`,
      visibleMessageID: `000005_${computeVisibleChecksum("user-2")}.hard`,
      anchorIndex: 4,
      text: "Reminder: compact older compressible context now unless it must remain verbatim.",
    });
    assert.equal(store.listHostMessages({ presentOnly: true }).length, 5);
  });
});

test("reminder service returns no artifact before thresholds are crossed", async () => {
  await withTempStore(async (store) => {
    const messages = [createEnvelope(createMessage("user-1", "user", 1), [createTextPart("user-1", "u1")])];
    store.syncCanonicalHostMessages({
      revision: "rev-reminder-2",
      syncedAtMs: 1,
      messages: [{ hostMessageID: "user-1", canonicalMessageID: "user-1", role: "user" }],
    });

    const policy = buildProjectionPolicy({ messages, store });
    const reminder = deriveReminder({
      policy,
      cadence: {
        softMessageCount: 2,
        hardMessageCount: 3,
      },
    });

    assert.equal(reminder, undefined);
  });
});

function createEnvelope(info: TransformMessage, parts: TransformPart[]): TransformEnvelope {
  return { info, parts };
}

function createMessage(id: string, role: string, created: number): TransformMessage {
  return {
    id,
    sessionID: "session-1",
    role,
    agent: "main",
    model: {
      providerID: "provider-1",
      modelID: "gpt-5",
    },
    time: { created },
  } as TransformMessage;
}

function createTextPart(messageID: string, text: string): TransformPart {
  return {
    id: `${messageID}:part`,
    sessionID: "session-1",
    messageID,
    type: "text",
    text,
  } as TransformPart;
}

async function withTempStore(run: (store: SqliteSessionStateStore) => Promise<void>): Promise<void> {
  const pluginDirectory = await mkdtemp(join(tmpdir(), "opencode-context-compression-reminder-"));
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "session-1",
    now: () => 1,
  });

  try {
    await run(store);
  } finally {
    store.close();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}
