import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildProjectionPolicy } from "../../src/projection/policy-engine.js";
import { deriveReminder } from "../../src/projection/reminder-service.js";
import {
  createSqliteSessionStateStore,
  type SqliteSessionStateStore,
} from "../../src/state/store.js";
import type {
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../../src/seams/noop-observation.js";
import { computeVisibleChecksum } from "../../src/identity/visible-sequence.js";
import { OpencodeContextCompressionTokenEstimationError } from "../../src/token-estimation.js";

test("reminder service derives a stable hard reminder from canonical history without persisting artifacts", async () => {
  await withTempStore(async (store) => {
    const repeatedTokenText = "token rich content ".repeat(10).trim();
    const messages = [
      createEnvelope(createMessage("user-1", "user", 1, 3), [
        createTextPart("user-1", repeatedTokenText),
      ]),
      createEnvelope(createMessage("assistant-1", "assistant", 2, 4), [
        createTextPart("assistant-1", repeatedTokenText),
      ]),
      createEnvelope(createMessage("tool-1", "tool", 3, 2), [
        createTextPart("tool-1", repeatedTokenText),
      ]),
      createEnvelope(createMessage("assistant-2", "assistant", 4, 5), [
        createTextPart("assistant-2", repeatedTokenText),
      ]),
      createEnvelope(createMessage("user-2", "user", 5, 6), [
        createTextPart("user-2", repeatedTokenText),
      ]),
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
    const templates = {
      soft: "Soft reminder text.",
      hard: "Hard reminder text.",
    };
    const first = deriveReminder({
      policy,
      cadence: {
        hsoft: 60,
        hhard: 120,
      },
      templates,
      modelName: "gpt-5",
    });
    const second = deriveReminder({
      policy,
      cadence: {
        hsoft: 60,
        hhard: 120,
      },
      templates,
      modelName: "gpt-5",
    });

    assert.deepEqual(first, second);
    assert.deepEqual(first, {
      severity: "hard",
      anchorHostMessageID: "user-2",
      anchorVisibleMessageID: `000005_${computeVisibleChecksum("user-2")}`,
      visibleMessageID: `000005_${computeVisibleChecksum("user-2")}.hard`,
      anchorIndex: 4,
      text: "Hard reminder text.",
    });
    assert.equal(store.listHostMessages({ presentOnly: true }).length, 5);
  });
});

test("reminder service returns no artifact before thresholds are crossed", async () => {
  await withTempStore(async (store) => {
    const messages = [
      createEnvelope(createMessage("user-1", "user", 1, 5), [
        createTextPart("user-1", "tiny"),
      ]),
    ];
    store.syncCanonicalHostMessages({
      revision: "rev-reminder-2",
      syncedAtMs: 1,
      messages: [
        { hostMessageID: "user-1", canonicalMessageID: "user-1", role: "user" },
      ],
    });

    const policy = buildProjectionPolicy({ messages, store });
    const reminder = deriveReminder({
      policy,
      cadence: {
        hsoft: 50,
        hhard: 60,
      },
      templates: { soft: "Soft.", hard: "Hard." },
      modelName: "gpt-5",
    });

    assert.equal(reminder, undefined);
  });
});

test("reminder counter repeatEvery changes when soft reminders are due", async () => {
  await withTempStore(async (store) => {
    const repeatedTokenText = "token rich content ".repeat(8).trim();
    const messages = [
      createEnvelope(createMessage("user-1", "user", 1, 4), [
        createTextPart("user-1", repeatedTokenText),
      ]),
      createEnvelope(createMessage("assistant-1", "assistant", 2, 3), [
        createTextPart("assistant-1", repeatedTokenText),
      ]),
      createEnvelope(createMessage("user-2", "user", 3, 5), [
        createTextPart("user-2", repeatedTokenText),
      ]),
    ];

    store.syncCanonicalHostMessages({
      revision: "rev-reminder-3",
      syncedAtMs: 1,
      messages: messages.map((message) => ({
        hostMessageID: message.info.id,
        canonicalMessageID: message.info.id,
        role: message.info.role,
      })),
    });

    const policy = buildProjectionPolicy({ messages, store });
    const templates = { soft: "Soft.", hard: "Hard." };
    const dueReminder = deriveReminder({
      policy,
      cadence: {
        hsoft: 40,
        hhard: 99,
        softRepeatEveryTokens: 2,
        hardRepeatEveryTokens: 1,
      },
      templates,
      modelName: "gpt-5",
    });
    const skippedReminder = deriveReminder({
      policy,
      cadence: {
        hsoft: 40,
        hhard: 99,
        softRepeatEveryTokens: 3,
        hardRepeatEveryTokens: 1,
      },
      templates,
      modelName: "gpt-5",
    });

    assert.equal(dueReminder?.severity, "soft");
    assert.equal(dueReminder?.anchorHostMessageID, "user-2");
    assert.equal(skippedReminder, undefined);
  });
});

test("reminder token cadence increases the anchor only when the next token milestone is crossed", async () => {
  await withTempStore(async (store) => {
    const repeatedTokenText = "token rich content ".repeat(8).trim();
    const messages = [
      createEnvelope(createMessage("user-1", "user", 1, 4), [
        createTextPart("user-1", repeatedTokenText),
      ]),
      createEnvelope(createMessage("assistant-1", "assistant", 2, 2), [
        createTextPart("assistant-1", repeatedTokenText),
      ]),
      createEnvelope(createMessage("user-2", "user", 3, 5), [
        createTextPart("user-2", repeatedTokenText),
      ]),
      createEnvelope(createMessage("user-3", "user", 4, 3), [
        createTextPart("user-3", repeatedTokenText),
      ]),
    ];

    store.syncCanonicalHostMessages({
      revision: "rev-reminder-4",
      syncedAtMs: 1,
      messages: messages.map((message) => ({
        hostMessageID: message.info.id,
        canonicalMessageID: message.info.id,
        role: message.info.role,
      })),
    });

    const policy = buildProjectionPolicy({ messages, store });
    const templates = { soft: "Soft.", hard: "Hard." };
    const eligibleReminder = deriveReminder({
      policy,
      cadence: {
        hsoft: 40,
        hhard: 99,
        softRepeatEveryTokens: 3,
        hardRepeatEveryTokens: 1,
      },
      templates,
      modelName: "gpt-5",
    });
    const assistantReminder = deriveReminder({
      policy,
      cadence: {
        hsoft: 40,
        hhard: 99,
        softRepeatEveryTokens: 300,
        hardRepeatEveryTokens: 1,
      },
      templates,
      modelName: "gpt-5",
    });

    assert.equal(eligibleReminder?.severity, "soft");
    assert.equal(eligibleReminder?.anchorHostMessageID, "user-3");
    assert.equal(assistantReminder, undefined);
  });
});

test("reminder thresholds ignore explicit tokenCount fields when tokenizer-based text size disagrees", async () => {
  await withTempStore(async (store) => {
    const longText = "long tokenized content ".repeat(40).trim();
    const messages = [
      createEnvelope(createMessage("user-1", "user", 1, 1), [
        createTextPart("user-1", longText),
      ]),
      createEnvelope(createMessage("assistant-1", "assistant", 2, 1), [
        createTextPart("assistant-1", longText),
      ]),
    ];

    store.syncCanonicalHostMessages({
      revision: "rev-reminder-5",
      syncedAtMs: 1,
      messages: messages.map((message) => ({
        hostMessageID: message.info.id,
        canonicalMessageID: message.info.id,
        role: message.info.role,
      })),
    });

    const policy = buildProjectionPolicy({ messages, store });
    const reminder = deriveReminder({
      policy,
      cadence: {
        hsoft: 20,
        hhard: 999,
      },
      templates: { soft: "Soft.", hard: "Hard." },
      modelName: "gpt-5",
    });

    assert.equal(reminder?.severity, "soft");
    assert.equal(reminder?.anchorHostMessageID, "assistant-1");
  });
});

test("reminder threshold tokenization fails fast when tokenizer resolution fails", async () => {
  await withTempStore(async (store) => {
    const messages = [
      createEnvelope(createMessage("user-1", "user", 1), [
        createTextPart("user-1", "token rich content"),
      ]),
    ];

    store.syncCanonicalHostMessages({
      revision: "rev-reminder-6",
      syncedAtMs: 1,
      messages: messages.map((message) => ({
        hostMessageID: message.info.id,
        canonicalMessageID: message.info.id,
        role: message.info.role,
      })),
    });

    const policy = buildProjectionPolicy({ messages, store });

    assert.throws(
      () =>
        deriveReminder({
          policy,
          cadence: {
            hsoft: 1,
            hhard: 2,
          },
          templates: { soft: "Soft.", hard: "Hard." },
          modelName: "unsupported-threshold-model",
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof OpencodeContextCompressionTokenEstimationError,
        );
        assert.match(String(error), /Unsupported tokenizer model/u);
        return true;
      },
    );
  });
});

function createEnvelope(
  info: TransformMessage,
  parts: TransformPart[],
): TransformEnvelope {
  return { info, parts };
}

function createMessage(
  id: string,
  role: string,
  created: number,
  tokenCount?: number,
): TransformMessage {
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
    ...(tokenCount === undefined ? {} : { tokenCount }),
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

async function withTempStore(
  run: (store: SqliteSessionStateStore) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-reminder-"),
  );
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
