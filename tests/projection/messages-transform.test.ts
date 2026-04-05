import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeVisibleChecksum } from "../../src/identity/visible-sequence.js";
import { createMessagesTransformHook } from "../../src/projection/messages-transform.js";
import type {
  MessagesTransformOutput,
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../../src/seams/noop-observation.js";
import { createInMemoryProjectionStoreFixture } from "./in-memory-projection-store.js";

test("messages.transform mutates output.messages in place and preserves metadata across reprocessing", async () => {
  await withTempPluginDirectory(async (pluginDirectory) => {
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

    const transform = createMessagesTransformHook({
      pluginDirectory,
      createStore: ({ sessionID: _sessionID }) =>
        createInMemoryProjectionStoreFixture({
          marks: [
            {
              markID: "mark-1",
              toolCallMessageID: "mark-tool-1",
              allowDelete: false,
              sourceMessageIDs: ["assistant-1", "tool-1"],
              status: "consumed",
              createdAtMs: 2,
              consumedAtMs: 3,
            },
          ],
          replacements: [
            {
              replacementID: "replacement-1",
              allowDelete: false,
              executionMode: "compact",
              committedAtMs: 3,
              contentText: "Compressed summary.",
              markIDs: ["mark-1"],
              sourceMessageIDs: ["assistant-1", "tool-1"],
            },
          ],
        }),
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
  });
});

test("messages.transform keeps user/system prefixes and prepends visible ids for assistant and tool text", async () => {
  await withTempPluginDirectory(async (pluginDirectory) => {
    const transform = createMessagesTransformHook({
      pluginDirectory,
      createStore: ({ sessionID: _sessionID }) =>
        createInMemoryProjectionStoreFixture(),
    });
    const output = {
      messages: [
        createEnvelope(
          createMessage({ id: "system-1", role: "system", created: 1 }),
          [createTextPart("system-1", "system policy")],
        ),
        createEnvelope(
          createMessage({ id: "user-1", role: "user", created: 2 }),
          [createTextPart("user-1", "hello there")],
        ),
        createEnvelope(
          createMessage({ id: "assistant-1", role: "assistant", created: 3 }),
          [createTextPart("assistant-1", "我先查一下。")],
        ),
        createEnvelope(
          createMessage({ id: "tool-1", role: "tool", created: 4 }),
          [createTextPart("tool-1", "Search results: ...")],
        ),
      ],
    } satisfies MessagesTransformOutput;

    await transform({}, output);

    assert.deepEqual(
      output.messages.map((message) => readText(message)),
      [
        `[protected_000001_${computeVisibleChecksum("system-1")}] system policy`,
        `[compressible_000002_${computeVisibleChecksum("user-1")}] hello there`,
        `[compressible_000003_${computeVisibleChecksum("assistant-1")}] 我先查一下。`,
        `[compressible_000004_${computeVisibleChecksum("tool-1")}] Search results: ...`,
      ],
    );
  });
});

test("messages.transform renders tool-only assistant shells and prepends tool ids into input_text arrays", async () => {
  await withTempPluginDirectory(async (pluginDirectory) => {
    const transform = createMessagesTransformHook({
      pluginDirectory,
      createStore: ({ sessionID: _sessionID }) =>
        createInMemoryProjectionStoreFixture(),
    });
    const output = {
      messages: [
        createEnvelope(
          createMessage({ id: "assistant-shell", role: "assistant", created: 1 }),
          [],
        ),
        createEnvelope(
          createMessage({ id: "tool-array", role: "tool", created: 2 }),
          [
            createInputTextPart("tool-array", "Search results: ...", 1),
            createInputTextPart("tool-array", "More context", 2),
          ],
        ),
      ],
    } satisfies MessagesTransformOutput;

    await transform({}, output);

    assert.equal(
      readText(output.messages[0]!),
      `[compressible_000001_${computeVisibleChecksum("assistant-shell")}]`,
    );
    assert.deepEqual(readInputTextTexts(output.messages[1]!), [
      `[compressible_000002_${computeVisibleChecksum("tool-array")}]`,
      "Search results: ...",
      "More context",
    ]);
  });
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

function createInputTextPart(
  messageID: string,
  text: string,
  index: number,
): TransformPart {
  return {
    id: `${messageID}:input-${index}`,
    sessionID: "session-1",
    messageID,
    type: "input_text",
    text,
  } as unknown as TransformPart;
}

function readText(message: TransformEnvelope): string {
  const textPart = message.parts.find((part) => part.type === "text") as
    | (TransformPart & { text: string })
    | undefined;
  return textPart?.text ?? "";
}

function readInputTextTexts(message: TransformEnvelope): string[] {
  return message.parts.flatMap((part) => {
    const candidate = part as Record<string, unknown>;
    return candidate.type === "input_text" && typeof candidate.text === "string"
      ? [candidate.text]
      : [];
  });
}

async function withTempPluginDirectory(
  run: (pluginDirectory: string) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-transform-"),
  );

  try {
    await run(pluginDirectory);
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}
