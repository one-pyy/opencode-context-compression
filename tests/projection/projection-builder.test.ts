import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReminderRuntimeConfig } from "../../src/config/runtime-config.js";
import { computeVisibleChecksum } from "../../src/identity/visible-sequence.js";
import { persistMark } from "../../src/marks/mark-service.js";
import { buildProjectedMessages } from "../../src/projection/projection-builder.js";
import { materializeProjectedMessages } from "../../src/projection/messages-transform.js";
import {
  createSqliteSessionStateStore,
  type SqliteSessionStateStore,
} from "../../src/state/store.js";
import type {
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../../src/seams/noop-observation.js";

test("projection builder replays history marks and uses the current best available child result when a newer covering mark has no result", async () => {
  await withTempStore(async (store, clock) => {
    const messages = [
      createEnvelope(
        createMessage({ id: "user-1", role: "user", created: 1 }),
        [createTextPart("user-1", "hello")],
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
        createMessage({ id: "mark-tool-small", role: "tool", created: 4 }),
        [createTextPart("mark-tool-small", "m_small")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-big", role: "tool", created: 5 }),
        [createTextPart("mark-tool-big", "m_big")],
      ),
      createEnvelope(
        createMessage({ id: "user-2", role: "user", created: 6 }),
        [createTextPart("user-2", "next")],
      ),
    ];

    syncMessages(store, clock, messages);
    persistMark({
      store,
      markID: "m_small",
      toolCallMessageID: "mark-tool-small",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "assistant-1" },
        { hostMessageID: "tool-1" },
      ],
    });
    persistMark({
      store,
      markID: "m_big",
      toolCallMessageID: "mark-tool-big",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "user-1" },
        { hostMessageID: "assistant-1" },
        { hostMessageID: "tool-1" },
        { hostMessageID: "mark-tool-small" },
        { hostMessageID: "mark-tool-big" },
        { hostMessageID: "user-2" },
      ],
    });
    store.commitReplacementResultGroup({
      primaryMarkID: "m_small",
      executionMode: "compact",
      committedAtMs: clock.tick(),
      items: [
        {
          contentText: "Compressed summary.",
          sourceSnapshot: {
            messages: [
              { hostMessageID: "assistant-1", role: "assistant" },
              { hostMessageID: "tool-1", role: "tool" },
            ],
          },
        },
      ],
    });

    const projection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
    });
    const renderedMessages = materializeProjectedMessages(projection.projectedMessages);

    assert.deepEqual(
      renderedMessages.map((message) => readText(message)),
      [
        `[compressible_000001_${computeVisibleChecksum("user-1")}] hello`,
        `[referable_000002_${computeVisibleChecksum("assistant-1")}] Compressed summary.`,
        `[compressible_000006_${computeVisibleChecksum("user-2")}] next`,
      ],
    );
    assert.deepEqual(
      projection.hiddenToolCallMessageIDs,
      ["mark-tool-big", "mark-tool-small"],
    );
    assert.equal(store.getMark("m_big")?.status, "active");
    assert.equal(store.getMark("m_small")?.status, "consumed");
  });
});

test("projection builder lets a covering ancestor take over once its own result group exists", async () => {
  await withTempStore(async (store, clock) => {
    const messages = [
      createEnvelope(
        createMessage({ id: "user-1", role: "user", created: 1 }),
        [createTextPart("user-1", "hello")],
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
        createMessage({ id: "mark-tool-small", role: "tool", created: 4 }),
        [createTextPart("mark-tool-small", "m_small")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-big", role: "tool", created: 5 }),
        [createTextPart("mark-tool-big", "m_big")],
      ),
      createEnvelope(
        createMessage({ id: "user-2", role: "user", created: 6 }),
        [createTextPart("user-2", "next")],
      ),
    ];

    syncMessages(store, clock, messages);
    persistMark({
      store,
      markID: "m_small",
      toolCallMessageID: "mark-tool-small",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "assistant-1" },
        { hostMessageID: "tool-1" },
      ],
    });
    persistMark({
      store,
      markID: "m_big",
      toolCallMessageID: "mark-tool-big",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "user-1" },
        { hostMessageID: "assistant-1" },
        { hostMessageID: "tool-1" },
        { hostMessageID: "mark-tool-small" },
        { hostMessageID: "mark-tool-big" },
        { hostMessageID: "user-2" },
      ],
    });
    store.commitReplacementResultGroup({
      primaryMarkID: "m_small",
      executionMode: "compact",
      committedAtMs: clock.tick(),
      items: [
        {
          contentText: "Compressed summary.",
          sourceSnapshot: {
            messages: [
              { hostMessageID: "assistant-1", role: "assistant" },
              { hostMessageID: "tool-1", role: "tool" },
            ],
          },
        },
      ],
    });
    store.commitReplacementResultGroup({
      primaryMarkID: "m_big",
      executionMode: "compact",
      committedAtMs: clock.tick(),
      items: [
        {
          contentText: "Big summary.",
          sourceSnapshot: {
            messages: [
              { hostMessageID: "user-1", role: "user" },
              { hostMessageID: "assistant-1", role: "assistant" },
              { hostMessageID: "tool-1", role: "tool" },
              { hostMessageID: "mark-tool-small", role: "tool" },
              { hostMessageID: "mark-tool-big", role: "tool" },
              { hostMessageID: "user-2", role: "user" },
            ],
          },
        },
      ],
    });

    const projection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
    });
    const renderedMessages = materializeProjectedMessages(projection.projectedMessages);

    assert.deepEqual(
      renderedMessages.map((message) => readText(message)),
      [`[referable_000001_${computeVisibleChecksum("user-1")}] Big summary.`],
    );
    assert.deepEqual(
      projection.hiddenToolCallMessageIDs,
      ["mark-tool-big", "mark-tool-small"],
    );
    assert.equal(store.getMark("m_big")?.status, "consumed");
  });
});

test("projection builder treats an equal-range later mark as the new parent while still falling back to the earlier child result", async () => {
  await withTempStore(async (store, clock) => {
    const messages = [
      createEnvelope(
        createMessage({ id: "user-1", role: "user", created: 1 }),
        [createTextPart("user-1", "hello")],
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
        createMessage({ id: "mark-tool-old", role: "tool", created: 4 }),
        [createTextPart("mark-tool-old", "m_old")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-new", role: "tool", created: 5 }),
        [createTextPart("mark-tool-new", "m_new")],
      ),
      createEnvelope(
        createMessage({ id: "user-2", role: "user", created: 6 }),
        [createTextPart("user-2", "next")],
      ),
    ];

    syncMessages(store, clock, messages);
    persistMark({
      store,
      markID: "m_old",
      toolCallMessageID: "mark-tool-old",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "assistant-1" },
        { hostMessageID: "tool-1" },
      ],
    });
    persistMark({
      store,
      markID: "m_new",
      toolCallMessageID: "mark-tool-new",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "assistant-1" },
        { hostMessageID: "tool-1" },
      ],
    });
    store.commitReplacementResultGroup({
      primaryMarkID: "m_old",
      executionMode: "compact",
      committedAtMs: clock.tick(),
      items: [
        {
          contentText: "Old summary.",
          sourceSnapshot: {
            messages: [
              { hostMessageID: "assistant-1", role: "assistant" },
              { hostMessageID: "tool-1", role: "tool" },
            ],
          },
        },
      ],
    });

    const projection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
    });
    const renderedMessages = materializeProjectedMessages(projection.projectedMessages);

    assert.deepEqual(
      renderedMessages.map((message) => readText(message)),
      [
        `[compressible_000001_${computeVisibleChecksum("user-1")}] hello`,
        `[referable_000002_${computeVisibleChecksum("assistant-1")}] Old summary.`,
        `[compressible_000006_${computeVisibleChecksum("user-2")}] next`,
      ],
    );
    assert.deepEqual(
      projection.hiddenToolCallMessageIDs,
      ["mark-tool-new", "mark-tool-old"],
    );
    assert.equal(store.getMark("m_new")?.status, "active");
    assert.equal(store.getMark("m_old")?.status, "consumed");
  });
});

test("projection builder rewrites intersecting later marks into visible error tool messages and excludes them from replay semantics", async () => {
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
        createMessage({ id: "tool-1", role: "tool", created: 3 }),
        [createTextPart("tool-1", "gamma")],
      ),
      createEnvelope(
        createMessage({ id: "tool-2", role: "tool", created: 4 }),
        [createTextPart("tool-2", "delta")],
      ),
      createEnvelope(
        createMessage({ id: "user-2", role: "user", created: 5 }),
        [createTextPart("user-2", "omega")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-left", role: "tool", created: 6 }),
        [createTextPart("mark-tool-left", "m_left")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-bad", role: "tool", created: 7 }),
        [createTextPart("mark-tool-bad", "m_bad")],
      ),
    ];

    syncMessages(store, clock, messages);
    persistMark({
      store,
      markID: "m_left",
      toolCallMessageID: "mark-tool-left",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "assistant-1" },
        { hostMessageID: "tool-1" },
        { hostMessageID: "tool-2" },
      ],
    });
    persistMark({
      store,
      markID: "m_bad",
      toolCallMessageID: "mark-tool-bad",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "tool-1" },
        { hostMessageID: "tool-2" },
        { hostMessageID: "user-2" },
      ],
    });
    store.commitReplacementResultGroup({
      primaryMarkID: "m_left",
      executionMode: "compact",
      committedAtMs: clock.tick(),
      items: [
        {
          contentText: "Left summary.",
          sourceSnapshot: {
            messages: [
              { hostMessageID: "assistant-1", role: "assistant" },
              { hostMessageID: "tool-1", role: "tool" },
              { hostMessageID: "tool-2", role: "tool" },
            ],
          },
        },
      ],
    });
    store.commitReplacementResultGroup({
      primaryMarkID: "m_bad",
      executionMode: "compact",
      committedAtMs: clock.tick(),
      items: [
        {
          contentText: "Bad summary should never render.",
          sourceSnapshot: {
            messages: [
              { hostMessageID: "tool-1", role: "tool" },
              { hostMessageID: "tool-2", role: "tool" },
              { hostMessageID: "user-2", role: "user" },
            ],
          },
        },
      ],
    });

    const projection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
    });

    const texts = materializeProjectedMessages(projection.projectedMessages).map((message) =>
      readText(message),
    );
    assert.match(texts[0] ?? "", /^\[compressible_[^\]]+\] alpha$/u);
    assert.match(
      texts[1] ?? "",
      /^\[referable_[^\]]+\] Left summary\.$/u,
    );
    assert.match(
      texts[2] ?? "",
      /^\[compressible_[^\]]+\] omega$/u,
    );
    assert.match(
      texts[3] ?? "",
      /^\[compressible_[^\]]+\] compression_mark replay error: mark 'm_bad' overlaps an earlier valid mark without containment/u,
    );
    assert.deepEqual(projection.hiddenToolCallMessageIDs, ["mark-tool-left"]);
    assert.equal(store.getMark("m_bad")?.status, "invalid");
    assert.match(
      store.getMark("m_bad")?.invalidationReason ?? "",
      /overlaps an earlier valid mark without containment/u,
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
        [createTextPart("mark-tool-1", "m_delete")],
      ),
      createEnvelope(
        createMessage({ id: "assistant-2", role: "assistant", created: 4 }),
        [createTextPart("assistant-2", "omega")],
      ),
    ];

    syncMessages(store, clock, messages);
    persistMark({
      store,
      markID: "m_delete",
      toolCallMessageID: "mark-tool-1",
      allowDelete: true,
      createdAtMs: clock.tick(),
      sourceMessages: [
        { hostMessageID: "user-1" },
        { hostMessageID: "assistant-1" },
      ],
    });
    store.commitReplacementResultGroup({
      primaryMarkID: "m_delete",
      executionMode: "delete",
      committedAtMs: clock.tick(),
      items: [
        {
          contentText: "Deleted source span notice.",
          sourceSnapshot: {
            messages: [
              { hostMessageID: "user-1", role: "user" },
              { hostMessageID: "assistant-1", role: "assistant" },
            ],
          },
        },
      ],
    });

    const projection = buildProjectedMessages({
      messages,
      store,
      reminder: undefined,
    });
    const renderedMessages = materializeProjectedMessages(projection.projectedMessages);

    assert.deepEqual(
      renderedMessages.map((message) => readText(message)),
      [
        `[referable_000001_${computeVisibleChecksum("user-1")}] Deleted source span notice.`,
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
    const renderedMessages = materializeProjectedMessages(projection.projectedMessages);

    assert.equal(projection.reminder?.severity, "soft");
    assert.deepEqual(
      renderedMessages.map((message) => readText(message)),
      [
        `[protected_000001_${computeVisibleChecksum("system-1")}] policy`,
        `[compressible_000002_${computeVisibleChecksum("user-1")}] alpha`,
        `[compressible_000003_${computeVisibleChecksum("assistant-1")}] beta`,
        `[protected_reminder_soft_${computeVisibleChecksum("assistant-1")}] Soft reminder text.`,
      ],
    );
  });
});

test("projection builder chooses delete-allowed reminder prompts from the current runtime permission seam, not persisted mark bits", async () => {
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
        [createTextPart("mark-tool-1", "m_keep")],
      ),
    ];

    syncMessages(store, clock, messages);
    persistMark({
      store,
      markID: "m_keep",
      toolCallMessageID: "mark-tool-1",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "assistant-1" }],
    });

    const deleteAllowedProjection = buildProjectedMessages({
      messages,
      store,
      reminder: {
        ...createReminderConfigFixture(),
        hsoft: 2,
        hhard: 99,
      },
      reminderModelName: "gpt-5",
      deleteModeAllowed: true,
    });
    const compactOnlyProjection = buildProjectedMessages({
      messages,
      store,
      reminder: {
        ...createReminderConfigFixture(),
        hsoft: 2,
        hhard: 99,
      },
      reminderModelName: "gpt-5",
      deleteModeAllowed: false,
    });

    assert.equal(deleteAllowedProjection.reminder?.text, "Soft delete-allowed reminder.");
    assert.equal(compactOnlyProjection.reminder?.text, "Soft reminder text.");
  });
});

test("projection builder replays mark precedence by canonical transcript order instead of host timestamp sorting", async () => {
  await withTempStore(async (store, clock) => {
    const messages = [
      createEnvelope(
        createMessage({ id: "user-1", role: "user", created: 100 }),
        [createTextPart("user-1", "alpha")],
      ),
      createEnvelope(
        createMessage({ id: "assistant-1", role: "assistant", created: 200 }),
        [createTextPart("assistant-1", "beta")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-earlier", role: "tool", created: 999 }),
        [createTextPart("mark-tool-earlier", "m_earlier")],
      ),
      createEnvelope(
        createMessage({ id: "mark-tool-later", role: "tool", created: 1 }),
        [createTextPart("mark-tool-later", "m_later")],
      ),
    ];

    syncMessages(store, clock, messages);
    persistMark({
      store,
      markID: "m_earlier",
      toolCallMessageID: "mark-tool-earlier",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "assistant-1" }],
    });
    persistMark({
      store,
      markID: "m_later",
      toolCallMessageID: "mark-tool-later",
      allowDelete: false,
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "assistant-1" }],
    });
    store.commitReplacementResultGroup({
      primaryMarkID: "m_earlier",
      executionMode: "compact",
      committedAtMs: clock.tick(),
      items: [
        {
          contentText: "Earlier transcript summary should not win.",
          sourceSnapshot: {
            messages: [{ hostMessageID: "assistant-1", role: "assistant" }],
          },
        },
      ],
    });
    store.commitReplacementResultGroup({
      primaryMarkID: "m_later",
      executionMode: "compact",
      committedAtMs: clock.tick(),
      items: [
        {
          contentText: "Later transcript summary wins.",
          sourceSnapshot: {
            messages: [{ hostMessageID: "assistant-1", role: "assistant" }],
          },
        },
      ],
    });

    const renderedMessages = materializeProjectedMessages(
      buildProjectedMessages({
        messages,
        store,
        reminder: undefined,
      }).projectedMessages,
    );

    assert.deepEqual(renderedMessages.map((message) => readText(message)), [
      `[compressible_000001_${computeVisibleChecksum("user-1")}] alpha`,
      `[referable_000002_${computeVisibleChecksum("assistant-1")}] Later transcript summary wins.`,
    ]);
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
    const renderedProtected = materializeProjectedMessages(
      protectedProjection.projectedMessages,
    );
    const renderedUnprotected = materializeProjectedMessages(
      unprotectedProjection.projectedMessages,
    );

    assert.deepEqual(
      renderedProtected.map((message) => readText(message)),
      [
        `[protected_000001_${computeVisibleChecksum("user-short")}] tiny`,
        `[compressible_000002_${computeVisibleChecksum("user-long")}] this is a much longer user message`,
        `[compressible_000003_${computeVisibleChecksum("assistant-1")}] reply`,
      ],
    );
    assert.deepEqual(
      renderedUnprotected.map((message) => readText(message)),
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
