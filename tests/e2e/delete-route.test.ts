import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runCompactionBatch,
  type CompactionRunnerTransport,
} from "../../src/compaction/runner.js";
import { computeVisibleChecksum } from "../../src/identity/visible-sequence.js";
import { persistMark } from "../../src/marks/mark-service.js";
import { createMessagesTransformHook } from "../../src/projection/messages-transform.js";
import {
  createSqliteSessionStateStore,
  type SqliteSessionStateStore,
} from "../../src/state/store.js";
import type {
  MessagesTransformOutput,
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../../src/seams/noop-observation.js";

test("delete route commits through the same replacement framework, projects a delete notice, and persists SQLite sidecar state", async () => {
  await withTempEnvironment(
    async ({ projectDirectory, lockDirectory, store, clock }) => {
      const canonicalMessages = [
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

      syncMessages(store, clock, canonicalMessages);
      persistMark({
        store,
        markID: "mark-delete-1",
        toolCallMessageID: "mark-tool-1",
        route: "delete",
        createdAtMs: clock.tick(),
        sourceMessages: [
          { hostMessageID: "user-1" },
          { hostMessageID: "assistant-1" },
        ],
      });

      const result = await runCompactionBatch({
        store,
        lockDirectory,
        sessionID: store.sessionID,
        promptText: "Produce a delete notice for the selected canonical span.",
        models: ["model-delete"],
        transport: createSafeTransport(async (request) => {
          assert.equal(request.input.route, "delete");
          assert.deepEqual(
            request.input.sourceMessages.map(
              (message) => message.hostMessageID,
            ),
            ["user-1", "assistant-1"],
          );
          return { contentText: "Deleted source span notice." };
        }),
        loadCanonicalSourceMessages: createCanonicalLoader({
          "user-1": "alpha",
          "assistant-1": "beta",
        }),
        now: () => clock.tick(),
      });

      assert.equal(result.started, true);
      if (!result.started) {
        assert.fail("expected delete-route compaction to start");
      }

      assert.equal(result.finalStatus, "succeeded");
      assert.equal(result.jobs[0]?.replacement?.route, "delete");

      const transform = createMessagesTransformHook({
        pluginDirectory: projectDirectory,
      });
      const output = {
        messages: canonicalMessages.map((message) => structuredClone(message)),
      } satisfies MessagesTransformOutput;

      await transform({}, output);

      assert.deepEqual(output.messages.map(readText), [
        `[referable_000001_${computeVisibleChecksum("user-1")}] Deleted source span notice.`,
        `[compressible_000004_${computeVisibleChecksum("assistant-2")}] omega`,
      ]);
      assert.deepEqual(
        querySqlite(
          store.databasePath,
          "SELECT route || '|' || status || '|' || COALESCE(content_text, '') FROM replacements ORDER BY replacement_id;",
        ),
        ["delete|committed|Deleted source span notice."],
      );
      assert.deepEqual(
        querySqlite(
          store.databasePath,
          "SELECT snapshot_kind || '|' || route || '|' || source_count FROM source_snapshots ORDER BY snapshot_kind, snapshot_id;",
        ),
        ["mark|delete|2", "replacement|delete|2"],
      );
      assert.deepEqual(
        querySqlite(
          store.databasePath,
          "SELECT replacements.route || '|' || replacement_mark_links.link_kind FROM replacements JOIN replacement_mark_links ON replacements.replacement_id = replacement_mark_links.replacement_id ORDER BY replacements.replacement_id;",
        ),
        ["delete|consumed"],
      );
      assert.deepEqual(
        querySqlite(
          store.databasePath,
          "SELECT mark_id || '|' || status FROM marks ORDER BY mark_id;",
        ),
        ["mark-delete-1|consumed"],
      );
    },
  );
});

async function withTempEnvironment(
  run: (context: {
    projectDirectory: string;
    lockDirectory: string;
    store: SqliteSessionStateStore;
    clock: ReturnType<typeof createClock>;
  }) => Promise<void>,
): Promise<void> {
  const projectDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-e2e-delete-"),
  );
  const lockDirectory = join(projectDirectory, "locks");
  const clock = createClock();
  const store = createSqliteSessionStateStore({
    pluginDirectory: projectDirectory,
    sessionID: "test-session",
    now: () => clock.current,
  });

  try {
    await run({ projectDirectory, lockDirectory, store, clock });
  } finally {
    store.close();
    await rm(projectDirectory, { recursive: true, force: true });
  }
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

function createSafeTransport(
  invoke: NonNullable<CompactionRunnerTransport["invoke"]>,
): CompactionRunnerTransport {
  return {
    candidate: {
      id: "plugin.compaction.invoke",
      owner: "plugin",
      entrypoint: "independent-model-call",
      promptContext: "dedicated-compaction-prompt",
      sessionEffects: {
        createsUserMessage: false,
        reusesSharedLoop: false,
        dependsOnBusyState: false,
        mutatesPermissions: false,
      },
      failureClassification: "deterministic",
    },
    invoke,
  };
}

function createCanonicalLoader(contentByHostMessageID: Record<string, string>) {
  return async ({
    sourceMessages,
  }: {
    sourceMessages: readonly {
      hostMessageID: string;
      canonicalMessageID: string;
      hostRole: string;
    }[];
  }) =>
    sourceMessages.map((sourceMessage) => {
      const content = contentByHostMessageID[sourceMessage.hostMessageID];
      if (content === undefined) {
        throw new Error(
          `Missing canonical content for '${sourceMessage.hostMessageID}'.`,
        );
      }

      return {
        hostMessageID: sourceMessage.hostMessageID,
        canonicalMessageID: sourceMessage.canonicalMessageID,
        role: sourceMessage.hostRole,
        content,
      };
    });
}

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
    sessionID: "test-session",
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
    sessionID: "test-session",
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

function querySqlite(databasePath: string, query: string): string[] {
  const output = execFileSync("sqlite3", [databasePath, query], {
    encoding: "utf8",
  });

  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
