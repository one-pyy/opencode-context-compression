import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReminderRuntimeConfig } from "../../src/config/runtime-config.js";
import { computeVisibleChecksum } from "../../src/identity/visible-sequence.js";
import { persistMark } from "../../src/marks/mark-service.js";
import { buildProjectedMessages } from "../../src/projection/projection-builder.js";
import {
  createSqliteSessionStateStore,
  type SqliteSessionStateStore,
} from "../../src/state/store.js";
import type {
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../../src/seams/noop-observation.js";

test("projection builder deterministically applies committed replacements and hides consumed mark tool calls only in the view", async () => {
  await withTempStore(async (store, clock) => {
    const messages = [
      createEnvelope(
        createMessage({ id: "system-1", role: "system", created: 1 }),
        [createTextPart("system-1", "system")],
      ),
      createEnvelope(
        createMessage({ id: "user-1", role: "user", created: 2 }),
        [createTextPart("user-1", "hello")],
      ),
      createEnvelope(
        createMessage({ id: "assistant-1", role: "assistant", created: 3 }),
        [createTextPart("assistant-1", "draft")],
      ),
      createEnvelope(
        createMessage({ id: "tool-1", role: "tool", created: 4 }),
        [createTextPart("tool-1", "tool output")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-1", role: "tool", created: 5 }),
        [createTextPart("mark-tool-1", "mark: a~b")],
      ),
      createEnvelope(
        createMessage({ id: "user-2", role: "user", created: 6 }),
        [createTextPart("user-2", "next")],
      ),
    ];

    syncMessages(store, clock, messages);
    persistMark({
      store,
      markID: "mark-1",
      toolCallMessageID: "mark-tool-1",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "assistant-1" },
        { hostMessageID: "tool-1" },
      ],
    });
    store.commitReplacement({
      replacementID: "replacement-1",
      allowDelete: false,
      executionMode: "compact",
      committedAtMs: clock.tick(),
      contentText: "Compressed summary.",
      markIDs: ["mark-1"],
      sourceSnapshot: {
        messages: [
          { hostMessageID: "assistant-1", role: "assistant" },
          { hostMessageID: "tool-1", role: "tool" },
        ],
      },
    });

    const firstProjection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
    });
    const secondProjection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
    });

    assert.equal(firstProjection.projectedMessages.length, 4);
    assert.deepEqual(
      firstProjection.projectedMessages.map((message) => readText(message)),
      [
        `[protected_000001_${computeVisibleChecksum("system-1")}] system`,
        `[compressible_000002_${computeVisibleChecksum("user-1")}] hello`,
        `[referable_000003_${computeVisibleChecksum("assistant-1")}] Compressed summary.`,
        `[compressible_000006_${computeVisibleChecksum("user-2")}] next`,
      ],
    );
    assert.deepEqual(firstProjection.hiddenToolCallMessageIDs, ["mark-tool-1"]);
    assert.deepEqual(firstProjection.appliedReplacementIDs, ["replacement-1"]);
    assert.equal(
      store.getMarkByToolCallMessageID("mark-tool-1")?.status,
      "consumed",
    );
    assert.equal(
      JSON.stringify(firstProjection.projectedMessages),
      JSON.stringify(secondProjection.projectedMessages),
    );
  });
});

test("projection builder renders committed delete replacements as minimal referable notices", async () => {
  await withTempStore(async (store, clock) => {
    const messages = [
      createEnvelope(
        createMessage({ id: "user-1", role: "user", created: 1 }),
        [createTextPart("user-1", "alpha")],
      ),
      createEnvelope(
        createMessage({ id: "assistant-1", role: "assistant", created: 2 }),
        [createTextPart("assistant-1", "beta")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-1", role: "tool", created: 3 }),
        [createTextPart("mark-tool-1", "mark: delete")],
      ),
      createEnvelope(
        createMessage({ id: "assistant-2", role: "assistant", created: 4 }),
        [createTextPart("assistant-2", "omega")],
      ),
    ];

    syncMessages(store, clock, messages);
    persistMark({
      store,
      markID: "mark-delete-1",
      toolCallMessageID: "mark-tool-1",
      allowDelete: true,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "user-1" },
        { hostMessageID: "assistant-1" },
      ],
    });
    store.commitReplacement({
      replacementID: "replacement-delete-1",
      allowDelete: true,
      executionMode: "delete",
      committedAtMs: clock.tick(),
      markIDs: ["mark-delete-1"],
      sourceSnapshot: {
        messages: [
          { hostMessageID: "user-1", role: "user" },
          { hostMessageID: "assistant-1", role: "assistant" },
        ],
      },
    });

    const projection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
    });

    assert.deepEqual(
      projection.projectedMessages.map((message) => readText(message)),
      [
        `[referable_000001_${computeVisibleChecksum("user-1")}] Deleted 2 earlier message(s).`,
        `[compressible_000004_${computeVisibleChecksum("assistant-2")}] omega`,
      ],
    );
  });
});

test("projection builder renders reminder artifacts from plain-text reminder config", async () => {
  await withTempStore(async (store, clock) => {
    const messages = [
      createEnvelope(
        createMessage({ id: "system-1", role: "system", created: 1 }),
        [createTextPart("system-1", "policy")],
      ),
      createEnvelope(
        createMessage({ id: "user-1", role: "user", created: 2 }),
        [createTextPart("user-1", "alpha")],
      ),
      createEnvelope(
        createMessage({ id: "assistant-1", role: "assistant", created: 3 }),
        [createTextPart("assistant-1", "beta")],
      ),
    ];

    syncMessages(store, clock, messages);

    const projection = buildProjectedMessages({
      messages,
      store,
      reminder: createReminderConfigFixture(),
      reminderModelName: "gpt-5",
    });

    assert.equal(projection.reminder?.severity, "soft");
    assert.deepEqual(
      projection.projectedMessages.map((message) => readText(message)),
      [
        `[protected_000001_${computeVisibleChecksum("system-1")}] policy`,
        `[compressible_000002_${computeVisibleChecksum("user-1")}] alpha`,
        `[compressible_000003_${computeVisibleChecksum("assistant-1")}] beta`,
        `[protected_000003_${computeVisibleChecksum("assistant-1")}.soft] Soft reminder text.`,
      ],
    );
  });
});

test("projection builder protects short user messages via smallUserMessageThreshold", async () => {
  await withTempStore(async (store, clock) => {
    const messages = [
      createEnvelope(
        createMessage({ id: "user-short", role: "user", created: 1 }),
        [createTextPart("user-short", "tiny")],
      ),
      createEnvelope(
        createMessage({ id: "user-long", role: "user", created: 2 }),
        [createTextPart("user-long", "this is a much longer user message")],
      ),
      createEnvelope(
        createMessage({ id: "assistant-1", role: "assistant", created: 3 }),
        [createTextPart("assistant-1", "reply")],
      ),
    ];

    syncMessages(store, clock, messages);

    const protectedProjection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
      smallUserMessageThreshold: 10,
    });
    const unprotectedProjection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
      smallUserMessageThreshold: 3,
    });

    assert.deepEqual(
      protectedProjection.projectedMessages.map((message) => readText(message)),
      [
        `[protected_000001_${computeVisibleChecksum("user-short")}] tiny`,
        `[compressible_000002_${computeVisibleChecksum("user-long")}] this is a much longer user message`,
        `[compressible_000003_${computeVisibleChecksum("assistant-1")}] reply`,
      ],
    );
    assert.deepEqual(
      unprotectedProjection.projectedMessages.map((message) =>
        readText(message),
      ),
      [
        `[compressible_000001_${computeVisibleChecksum("user-short")}] tiny`,
        `[compressible_000002_${computeVisibleChecksum("user-long")}] this is a much longer user message`,
        `[compressible_000003_${computeVisibleChecksum("assistant-1")}] reply`,
      ],
    );
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

function readText(message: TransformEnvelope): string {
  const textPart = message.parts.find((part) => part.type === "text") as
    | (TransformPart & { text: string })
    | undefined;
  return textPart?.text ?? "";
}

function syncMessages(
  store: SqliteSessionStateStore,
  clock: ReturnType<typeof createClock>,
  messages: readonly TransformEnvelope[],
): void {
  store.syncCanonicalHostMessages({
    revision: `rev-${clock.tick()}`,
    syncedAtMs: clock.current,
    messages: messages.map((message) => ({
      hostMessageID: message.info.id,
      canonicalMessageID: message.info.id,
      role: message.info.role,
      hostCreatedAtMs:
        typeof message.info.time?.created === "number"
          ? message.info.time.created
          : undefined,
    })),
  });
}

async function withTempStore(
  run: (
    store: SqliteSessionStateStore,
    clock: ReturnType<typeof createClock>,
  ) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-projection-"),
  );
  const clock = createClock();
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "session-1",
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

function createReminderConfigFixture(): ReminderRuntimeConfig {
  return {
    hsoft: 2,
    hhard: 4,
    softRepeatEveryTokens: 2,
    hardRepeatEveryTokens: 1,
    prompts: {
      compactOnly: {
        soft: {
          path: "/tmp/reminder-soft-compact-only.md",
          text: "Soft reminder text.",
        },
        hard: {
          path: "/tmp/reminder-hard-compact-only.md",
          text: "Hard reminder text.",
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
  };
}
