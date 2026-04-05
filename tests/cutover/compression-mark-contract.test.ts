import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { buildProjectedMessages } from "../../src/projection/projection-builder.js";
import { freezeCurrentCompactionBatch } from "../../src/marks/batch-freeze.js";
import { persistMark } from "../../src/marks/mark-service.js";
import { releaseSessionFileLock } from "../../src/runtime/file-lock.js";
import { createSqliteSessionStateStore } from "../../src/state/store.js";
import type {
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../../src/seams/noop-observation.js";
import {
  readInstalledPluginTypes,
  withLoadedPluginHooks,
} from "./cutover-test-helpers.js";

test("plugin entrypoint exposes repo-local compression_mark through Hooks.tool", async () => {
  const installedPluginTypes = await readInstalledPluginTypes();
  assert.match(
    installedPluginTypes,
    /tool\?:\s*\{\s*\[key: string\]: ToolDefinition;/u,
    "expected installed @opencode-ai/plugin types to expose Hooks.tool before auditing the cutover contract",
  );

  await withLoadedPluginHooks(async ({ hooks }) => {
    const hookKeys = Object.keys(hooks).sort();
    const toolRegistry = (
      hooks as {
        tool?: Record<
          string,
          { execute(args: unknown, context: unknown): Promise<string> }
        >;
      }
    ).tool;
    const toolKeys =
      toolRegistry && typeof toolRegistry === "object"
        ? Object.keys(toolRegistry).sort()
        : [];

    if (
      !toolRegistry ||
      typeof toolRegistry !== "object" ||
      !("compression_mark" in toolRegistry)
    ) {
      assert.fail(
        [
          "Cutover gap: plugin entrypoint must expose a repo-local public `compression_mark` tool via `Hooks.tool`.",
          "The installed @opencode-ai/plugin type surface already supports `Hooks.tool`, so this is a missing plugin contract rather than an upstream API limitation.",
          `Current hook keys from src/index.ts: ${hookKeys.join(", ") || "(none)"}.`,
          `Current tool keys: ${toolKeys.join(", ") || "(missing Hooks.tool registry)"}.`,
        ].join("\n"),
      );
    }

    assert.deepEqual(toolKeys, ["compression_mark"]);
  });
});

test("compression_mark v1 resolves visible ids, persists durable source snapshots, and uses the tool-call host message as anchor", async () => {
  await withLoadedPluginHooks(async ({ hooks, tempDirectory }) => {
    const sessionID = "test-session";
    const store = createSqliteSessionStateStore({
      pluginDirectory: tempDirectory,
      sessionID,
    });

    try {
      const canonicalMessages = [
        createEnvelope(
          createMessage({ id: "user-1", role: "user", created: 1 }),
          [createTextPart("user-1", "hello")],
        ),
        createEnvelope(
          createMessage({ id: "assistant-1", role: "assistant", created: 2 }),
          [createTextPart("assistant-1", "draft")],
        ),
        createEnvelope(
          createMessage({ id: "user-2", role: "user", created: 3 }),
          [createTextPart("user-2", "next")],
        ),
      ];

      store.syncCanonicalHostMessages({
        revision: "rev-cutover-1",
        syncedAtMs: 3,
        messages: canonicalMessages.map((message) => ({
          hostMessageID: message.info.id,
          canonicalMessageID: message.info.id,
          role: message.info.role,
          hostCreatedAtMs: message.info.time.created,
        })),
      });

      const projectedMessages = buildProjectedMessages({
        messages: canonicalMessages,
        store,
      }).projectedMessages;
      const compressionMark = readCompressionMarkTool(hooks);
      const output = await compressionMark.execute(
        {
          contractVersion: "v1",
          mode: "compact",
          target: {
            startVisibleMessageID: readVisibleMessageID(projectedMessages[1]),
            endVisibleMessageID: readVisibleMessageID(projectedMessages[2]),
          },
        },
        createToolContext({
          tempDirectory,
          sessionID,
          messageID: "assistant-mark-call-1",
          messages: projectedMessages,
        }),
      );

      const mark = store.getMarkByToolCallMessageID("assistant-mark-call-1");
      assert.ok(mark);
      assert.equal(output, mark?.markID);
      assert.match(output, /^m_[0-9a-f]{32}$/u);
      assert.equal(mark?.allowDelete, false);
      assert.equal(
        mark?.markLabel,
        `${readVisibleMessageID(projectedMessages[1])}~${readVisibleMessageID(projectedMessages[2])}`,
      );
      assert.deepEqual(store.getHostMessage("assistant-mark-call-1"), {
        hostMessageID: "assistant-mark-call-1",
        canonicalMessageID: "assistant-mark-call-1",
        role: "assistant",
        hostCreatedAtMs: undefined,
        canonicalPresent: true,
        firstSeenAtMs: store.getHostMessage("assistant-mark-call-1")
          ?.firstSeenAtMs,
        lastSeenAtMs: store.getHostMessage("assistant-mark-call-1")
          ?.lastSeenAtMs,
        lastSeenRevision: "rev-cutover-1",
        visibleSeq: undefined,
        visibleChecksum: undefined,
        metadata: undefined,
        updatedAtMs: store.getHostMessage("assistant-mark-call-1")?.updatedAtMs,
      });
      assert.deepEqual(
        store.listMarkSourceMessages(mark!.markID).map((message) => ({
          hostMessageID: message.hostMessageID,
          canonicalMessageID: message.canonicalMessageID,
          hostRole: message.hostRole,
        })),
        [
          {
            hostMessageID: "assistant-1",
            canonicalMessageID: "assistant-1",
            hostRole: "assistant",
          },
          {
            hostMessageID: "user-2",
            canonicalMessageID: "user-2",
            hostRole: "user",
          },
        ],
      );
      assert.deepEqual(mark?.metadata, {
        toolName: "compression_mark",
        contractVersion: "v1",
        mode: "compact",
        target: {
          startVisibleMessageID: readVisibleMessageID(projectedMessages[1]),
          endVisibleMessageID: readVisibleMessageID(projectedMessages[2]),
        },
        selectors: {
          startVisibleMessageID: readVisibleMessageID(projectedMessages[1]),
          endVisibleMessageID: readVisibleMessageID(projectedMessages[2]),
        },
        resolvedVisibleMessageIDs: [
          readVisibleMessageID(projectedMessages[1]),
          readVisibleMessageID(projectedMessages[2]),
        ],
        resolvedHostMessageIDs: ["assistant-1", "user-2"],
      });

      const repeatedOutput = await compressionMark.execute(
        {
          contractVersion: "v1",
          mode: "compact",
          target: {
            startVisibleMessageID: readVisibleMessageID(projectedMessages[1]),
            endVisibleMessageID: readVisibleMessageID(projectedMessages[2]),
          },
        },
        createToolContext({
          tempDirectory,
          sessionID,
          messageID: "assistant-mark-call-1",
          messages: projectedMessages,
        }),
      );
      assert.equal(repeatedOutput, output);
    } finally {
      store.close();
    }
  });
});

test("compression_mark v1 rejects mode=delete when current policy does not allow delete", async () => {
  const policyDenied = false;
  await withLoadedPluginHooks(async ({ tempDirectory }) => {
    const sessionID = "test-session";
    const store = createSqliteSessionStateStore({
      pluginDirectory: tempDirectory,
      sessionID,
    });

    try {
      const canonicalMessages = [
        createEnvelope(
          createMessage({ id: "user-1", role: "user", created: 1 }),
          [createTextPart("user-1", "hello")],
        ),
        createEnvelope(
          createMessage({ id: "assistant-1", role: "assistant", created: 2 }),
          [createTextPart("assistant-1", "draft")],
        ),
      ];

      store.syncCanonicalHostMessages({
        revision: "rev-cutover-deny",
        syncedAtMs: 2,
        messages: canonicalMessages.map((message) => ({
          hostMessageID: message.info.id,
          canonicalMessageID: message.info.id,
          role: message.info.role,
          hostCreatedAtMs: message.info.time.created,
        })),
      });

      const projectedMessages = buildProjectedMessages({
        messages: canonicalMessages,
        store,
      }).projectedMessages;
      const deniedCompressionMark = await createCompressionMarkForTest({
        tempDirectory,
        isDeleteModeAllowed: () => policyDenied,
      });

      await assert.rejects(
        deniedCompressionMark.execute(
          {
            contractVersion: "v1",
            mode: "delete",
            target: {
              startVisibleMessageID: readVisibleMessageID(projectedMessages[0]),
              endVisibleMessageID: readVisibleMessageID(projectedMessages[1]),
            },
          },
          createToolContext({
            tempDirectory,
            sessionID,
            messageID: "assistant-mark-call-denied",
            messages: projectedMessages,
          }),
        ),
        /compression_mark mode=delete is not allowed by the current policy\./u,
      );
      assert.equal(
        store.getMarkByToolCallMessageID("assistant-mark-call-denied"),
        undefined,
      );
    } finally {
      store.close();
    }
  });
});

test("compression_mark v1 preserves current delete admission capability for compact marks without binding persistence to mode alone", async () => {
  await withLoadedPluginHooks(async ({ tempDirectory }) => {
    const sessionID = "test-session";
    const store = createSqliteSessionStateStore({
      pluginDirectory: tempDirectory,
      sessionID,
    });

    try {
      const canonicalMessages = [
        createEnvelope(
          createMessage({ id: "assistant-1", role: "assistant", created: 1 }),
          [createTextPart("assistant-1", "draft")],
        ),
        createEnvelope(
          createMessage({ id: "user-1", role: "user", created: 2 }),
          [createTextPart("user-1", "follow-up")],
        ),
      ];

      store.syncCanonicalHostMessages({
        revision: "rev-cutover-policy-allowed",
        syncedAtMs: 2,
        messages: canonicalMessages.map((message) => ({
          hostMessageID: message.info.id,
          canonicalMessageID: message.info.id,
          role: message.info.role,
          hostCreatedAtMs: message.info.time.created,
        })),
      });

      const projectedMessages = buildProjectedMessages({
        messages: canonicalMessages,
        store,
      }).projectedMessages;
      const policyAllowedCompressionMark = await createCompressionMarkForTest({
        tempDirectory,
        isDeleteModeAllowed: () => true,
      });

      const output = await policyAllowedCompressionMark.execute(
        {
          contractVersion: "v1",
          mode: "compact",
          target: {
            startVisibleMessageID: readVisibleMessageID(projectedMessages[0]),
            endVisibleMessageID: readVisibleMessageID(projectedMessages[1]),
          },
        },
        createToolContext({
          tempDirectory,
          sessionID,
          messageID: "assistant-mark-call-policy-allowed",
          messages: projectedMessages,
        }),
      );

      const mark = store.getMarkByToolCallMessageID(
        "assistant-mark-call-policy-allowed",
      );
      assert.equal(output, mark?.markID);
      assert.equal(mark?.allowDelete, true);
      assert.deepEqual(mark?.metadata, {
        toolName: "compression_mark",
        contractVersion: "v1",
        mode: "compact",
        target: {
          startVisibleMessageID: readVisibleMessageID(projectedMessages[0]),
          endVisibleMessageID: readVisibleMessageID(projectedMessages[1]),
        },
        selectors: {
          startVisibleMessageID: readVisibleMessageID(projectedMessages[0]),
          endVisibleMessageID: readVisibleMessageID(projectedMessages[1]),
        },
        resolvedVisibleMessageIDs: [
          readVisibleMessageID(projectedMessages[0]),
          readVisibleMessageID(projectedMessages[1]),
        ],
        resolvedHostMessageIDs: ["assistant-1", "user-1"],
      });
    } finally {
      store.close();
    }
  });
});

test("compression_mark remains callable during lock and late marks stay out of the frozen active batch", async () => {
  await withLoadedPluginHooks(async ({ hooks, tempDirectory }) => {
    const sessionID = "test-session";
    const lockDirectory = join(tempDirectory, "locks");
    const store = createSqliteSessionStateStore({
      pluginDirectory: tempDirectory,
      sessionID,
    });

    try {
      const canonicalMessages = [
        createEnvelope(
          createMessage({ id: "user-1", role: "user", created: 1 }),
          [createTextPart("user-1", "hello")],
        ),
        createEnvelope(
          createMessage({ id: "assistant-1", role: "assistant", created: 2 }),
          [createTextPart("assistant-1", "draft")],
        ),
        createEnvelope(
          createMessage({ id: "mark-tool-1", role: "assistant", created: 3 }),
          [createTextPart("mark-tool-1", "existing mark")],
        ),
      ];

      store.syncCanonicalHostMessages({
        revision: "rev-cutover-lock",
        syncedAtMs: 3,
        messages: canonicalMessages.map((message) => ({
          hostMessageID: message.info.id,
          canonicalMessageID: message.info.id,
          role: message.info.role,
          hostCreatedAtMs: message.info.time.created,
        })),
      });
      persistMark({
        store,
        markID: "existing-mark-1",
        toolCallMessageID: "mark-tool-1",
        allowDelete: false,
        sourceMessages: [{ hostMessageID: "assistant-1" }],
      });

      const frozen = await freezeCurrentCompactionBatch({
        store,
        lockDirectory,
        sessionID,
        batchID: "batch-lock-1",
      });
      assert.equal(frozen.started, true);
      if (!frozen.started) {
        assert.fail("expected lock-time batch freeze to start");
      }

      const projectedMessages = buildProjectedMessages({
        messages: canonicalMessages,
        store,
      }).projectedMessages;
      const toolExecuteBefore = hooks["tool.execute.before"] as
        | ((
            input: { tool: string; sessionID: string; callID: string },
            output: { args: unknown },
          ) => Promise<void>)
        | undefined;
      await toolExecuteBefore?.(
        {
          tool: "compression_mark",
          sessionID,
          callID: "call-lock-1",
        },
        { args: {} },
      );

      const output = await readCompressionMarkTool(hooks).execute(
        {
          contractVersion: "v1",
          mode: "delete",
          target: {
            startVisibleMessageID: readVisibleMessageID(projectedMessages[0]),
            endVisibleMessageID: readVisibleMessageID(projectedMessages[1]),
          },
        },
        createToolContext({
          tempDirectory,
          sessionID,
          messageID: "assistant-mark-call-2",
          messages: projectedMessages,
        }),
      );

      assert.match(output, /^m_[0-9a-f]{32}$/u);
      assert.deepEqual(
        store
          .listCompactionBatchMarks(frozen.persistedBatch.batchID)
          .map((member) => member.markID),
        ["existing-mark-1"],
      );
      assert.deepEqual(
        store.listMarks({ status: "active" }).map((mark) => mark.markID),
        [
          "existing-mark-1",
          output,
        ],
      );
    } finally {
      await releaseSessionFileLock({
        lockDirectory,
        sessionID,
      });
      store.close();
    }
  });
});

function readCompressionMarkTool(hooks: Record<string, unknown>) {
  const toolRegistry = (
    hooks as {
      tool?: Record<
        string,
        { execute(args: unknown, context: unknown): Promise<string> }
      >;
    }
  ).tool;
  const compressionMark = toolRegistry?.compression_mark;
  if (compressionMark === undefined) {
    throw new Error("compression_mark tool missing from plugin hooks");
  }

  return compressionMark;
}

async function createCompressionMarkForTest(input: {
  readonly tempDirectory: string;
  readonly isDeleteModeAllowed?: (input: {
    readonly context: {
      readonly sessionID: string;
      readonly messageID: string;
      readonly messages?: readonly TransformEnvelope[];
    };
    readonly messages: readonly TransformEnvelope[];
  }) => boolean;
}) {
  const { createCompressionMarkTool } = await import(
    "../../src/tools/compression-mark.js"
  );
  return createCompressionMarkTool({
    pluginDirectory: input.tempDirectory,
    isDeleteModeAllowed: input.isDeleteModeAllowed,
  });
}

function createToolContext(input: {
  readonly tempDirectory: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly messages: ReturnType<
    typeof buildProjectedMessages
  >["projectedMessages"];
}) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    agent: "main",
    directory: input.tempDirectory,
    worktree: input.tempDirectory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
    messages: input.messages,
  };
}

function createEnvelope(
  info: TransformMessage,
  parts: TransformPart[],
): TransformEnvelope {
  return {
    info,
    parts,
  };
}

function createMessage(input: {
  readonly id: string;
  readonly role: string;
  readonly created: number;
}): TransformMessage {
  return {
    id: input.id,
    sessionID: "test-session",
    role: input.role,
    time: { created: input.created },
    agent: "main",
    model: {
      providerID: "provider-1",
      modelID: "gpt-5",
    },
  } as TransformMessage;
}

function createTextPart(messageID: string, text: string): TransformPart {
  return {
    id: `${messageID}:part`,
    sessionID: "test-session",
    messageID,
    type: "text",
    text,
  } as TransformPart;
}

function readVisibleMessageID(
  message: { parts: Array<Record<string, unknown>> } | undefined,
): string {
  const textPart = message?.parts.find(
    (part) => part.type === "text" && typeof part.text === "string",
  );
  const text = typeof textPart?.text === "string" ? textPart.text : undefined;
  const match =
    typeof text === "string"
      ? /^\[(?:protected|referable|compressible)_([^\]]+)\]/u.exec(text)
      : null;
  const visibleMessageID = match?.[1];
  if (typeof visibleMessageID !== "string" || visibleMessageID.length === 0) {
    throw new Error(
      `Unable to read visible message id from projected text '${String(text)}'.`,
    );
  }

  return visibleMessageID;
}
