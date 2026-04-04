import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistMark } from "../../src/marks/mark-service.js";
import { createMessagesTransformHook } from "../../src/projection/messages-transform.js";
import { createSqliteSessionStateStore } from "../../src/state/store.js";
import type {
  MessagesTransformOutput,
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../../src/seams/noop-observation.js";

test("messages.transform mutates output.messages in place and preserves metadata across reprocessing", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-transform-"),
  );
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "session-1",
    now: () => 1,
  });

  try {
    const canonicalMessages = [
      createEnvelope(
        createMessage({
          id: "user-1",
          role: "user",
          created: 1,
          extra: { custom: "keep-me" },
        }),
        [createTextPart("user-1", "hello", { source: "user" })],
      ),
      createEnvelope(
        createMessage({ id: "assistant-1", role: "assistant", created: 2 }),
        [createTextPart("assistant-1", "draft")],
      ),
      createEnvelope(
        createMessage({ id: "tool-1", role: "tool", created: 3 }),
        [createTextPart("tool-1", "tool output")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-1", role: "tool", created: 4 }),
        [createTextPart("mark-tool-1", "mark: a~b")],
      ),
    ];

    store.syncCanonicalHostMessages({
      revision: "rev-transform-1",
      syncedAtMs: 1,
      messages: canonicalMessages.map((message) => ({
        hostMessageID: message.info.id,
        canonicalMessageID: message.info.id,
        role: message.info.role,
      })),
    });
    persistMark({
      store,
      markID: "mark-1",
      toolCallMessageID: "mark-tool-1",
      allowDelete: false,
      createdAtMs: 2,
      sourceMessages: [
        { hostMessageID: "assistant-1" },
        { hostMessageID: "tool-1" },
      ],
    });
    store.commitReplacement({
      replacementID: "replacement-1",
      allowDelete: false,
      executionMode: "compact",
      committedAtMs: 3,
      contentText: "Compressed summary.",
      markIDs: ["mark-1"],
      sourceSnapshot: {
        messages: [
          { hostMessageID: "assistant-1", role: "assistant" },
          { hostMessageID: "tool-1", role: "tool" },
        ],
      },
    });

    const transform = createMessagesTransformHook({
      pluginDirectory,
      reminder: {
        hsoft: 10,
        hhard: 20,
        softRepeatEveryTokens: 10,
        hardRepeatEveryTokens: 10,
        prompts: {
          compactOnly: {
            soft: {
              path: "/tmp/reminder-soft-compact-only.md",
              text: "Soft compact-only reminder.",
            },
            hard: {
              path: "/tmp/reminder-hard-compact-only.md",
              text: "Hard compact-only reminder.",
            },
          },
          deleteAllowed: {
            soft: {
              path: "/tmp/reminder-soft-delete-allowed.md",
              text: "Soft delete-allowed reminder.",
            },
            hard: {
              path: "/tmp/reminder-hard-delete-allowed.md",
              text: "Hard delete-allowed reminder.",
            },
          },
        },
      },
      reminderModelName: "gpt-5",
    });
    const output = {
      messages: canonicalMessages.map((message) => structuredClone(message)),
    } satisfies MessagesTransformOutput;
    const originalArray = output.messages;

    await transform({}, output);

    const firstProjection = JSON.stringify(output.messages);
    assert.equal(output.messages, originalArray);
    assert.equal(output.messages.length, 2);
    assert.match(readText(output.messages[0]!), /^\[compressible_000001_/);
    assert.match(readText(output.messages[1]!), /^\[referable_000002_/);
    assert.equal(
      (output.messages[0]!.info as Record<string, unknown>).custom,
      "keep-me",
    );
    assert.deepEqual(
      (output.messages[0]!.parts[0] as Record<string, unknown>).metadata,
      { source: "user" },
    );

    await transform({}, output);

    assert.equal(JSON.stringify(output.messages), firstProjection);
    assert.equal(
      store.getMarkByToolCallMessageID("mark-tool-1")?.toolCallMessageID,
      "mark-tool-1",
    );
  } finally {
    store.close();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

function createEnvelope(
  info: TransformMessage,
  parts: TransformPart[],
): TransformEnvelope {
  return { info, parts };
}

function createMessage(input: {
  readonly id: string;
  readonly role: string;
  readonly created: number;
  readonly extra?: Record<string, unknown>;
}): TransformMessage {
  return {
    id: input.id,
    sessionID: "session-1",
    role: input.role,
    agent: "main",
    model: {
      providerID: "provider-1",
      modelID: "gpt-5",
    },
    time: { created: input.created },
    ...input.extra,
  } as TransformMessage;
}

function createTextPart(
  messageID: string,
  text: string,
  metadata?: Record<string, unknown>,
): TransformPart {
  return {
    id: `${messageID}:part`,
    sessionID: "session-1",
    messageID,
    type: "text",
    text,
    ...(metadata ? { metadata } : {}),
  } as TransformPart;
}

function readText(message: TransformEnvelope): string {
  const textPart = message.parts.find((part) => part.type === "text") as
    | (TransformPart & { text: string })
    | undefined;
  return textPart?.text ?? "";
}
