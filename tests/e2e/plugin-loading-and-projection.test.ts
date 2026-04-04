import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  runCompactionBatch,
  type CompactionRunnerTransport,
} from "../../src/compaction/runner.js";
import { computeVisibleChecksum } from "../../src/identity/visible-sequence.js";
import { persistMark } from "../../src/marks/mark-service.js";
import { createMessagesTransformHook } from "../../src/projection/messages-transform.js";
import { releaseSessionFileLock } from "../../src/runtime/file-lock.js";
import {
  guardToolExecutionDuringLock,
  waitForOrdinaryChatGateIfNeeded,
} from "../../src/runtime/send-entry-gate.js";
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

const PLUGIN_ENTRY =
  "/root/_/opencode/opencode-context-compression/src/index.ts";

test("explicit absolute-path plugin loading initializes hooks for a temp project and writes operator-visible side effects", async () => {
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-e2e-load-"),
  );
  const configDirectory = join(tempDirectory, "opencode-config");
  const seamLogPath = join(tempDirectory, "seam-observation.jsonl");
  const configPath = join(configDirectory, "opencode.json");
  const originalSeamLog = process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG;

  try {
    await mkdir(configDirectory, { recursive: true });
    const configSource =
      JSON.stringify(
        {
          plugin: [PLUGIN_ENTRY],
          compaction: {
            auto: false,
            prune: false,
          },
        },
        null,
        2,
      ) + "\n";

    await writeFile(configPath, configSource, "utf8");

    process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG = seamLogPath;
    const pluginModule = (await import(pathToFileURL(PLUGIN_ENTRY).href)) as {
      default: (ctx: {
        directory: string;
        worktree: string;
        client: { session: Record<string, unknown> };
      }) => Promise<
        Record<string, (...args: unknown[]) => Promise<void> | void>
      >;
    };
    const hooks = await pluginModule.default({
      directory: tempDirectory,
      worktree: tempDirectory,
      client: {
        session: {},
      },
    });

    const transform = hooks["experimental.chat.messages.transform"] as
      | ((input: unknown, output: MessagesTransformOutput) => Promise<void>)
      | undefined;

    assert.equal(typeof transform, "function");
    assert.equal(typeof hooks["chat.message"], "function");
    assert.equal(typeof hooks["tool.execute.before"], "function");

    const output = {
      messages: [
        createEnvelope(
          createMessage({ id: "user-load-1", role: "user", created: 1 }),
          [createTextPart("user-load-1", "load-check")],
        ),
      ],
    } satisfies MessagesTransformOutput;

    await transform?.({}, output);

    const savedConfig = await readFile(configPath, "utf8");
    const seamLog = await readFile(seamLogPath, "utf8");
    const observations = parseObservationLog(seamLog);

    assert.match(
      savedConfig,
      /\/root\/_\/opencode\/opencode-context-compression\/src\/index\.ts/u,
    );
    assert.ok(
      observations.some(
        (observation) => observation.seam === "tool.execute.before",
      ),
      "expected plugin init observation to be recorded through the seam journal",
    );
    assert.ok(
      observations.some((observation) =>
        observation.identityFields.some(
          (field) =>
            field.path === "pluginInit.directory" &&
            field.value === tempDirectory,
        ),
      ),
      "expected plugin init observation to point at the temp project directory",
    );
    assert.ok(
      observations.some((observation) =>
        observation.identityFields.some(
          (field) =>
            field.path === "pluginInit.worktree" &&
            field.value === tempDirectory,
        ),
      ),
      "expected plugin init worktree to point at the temp project directory",
    );
    assert.deepEqual(
      querySqlite(
        join(tempDirectory, "state", "test-session.db"),
        "SELECT host_message_id || '|' || canonical_present FROM host_messages ORDER BY host_message_id;",
      ),
      ["user-load-1|1"],
    );
  } finally {
    if (originalSeamLog === undefined) {
      delete process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG;
    } else {
      process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG = originalSeamLog;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("keep route persists committed sidecar state and projects deterministically across reruns", async () => {
  await withTempEnvironment(
    async ({ projectDirectory, lockDirectory, store, clock }) => {
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
          createMessage({ id: "tool-1", role: "tool", created: 3 }),
          [createTextPart("tool-1", "tool output")],
        ),
        createEnvelope(
          createMessage({ id: "mark-tool-1", role: "tool", created: 4 }),
          [createTextPart("mark-tool-1", "mark: a~b")],
        ),
        createEnvelope(
          createMessage({ id: "user-2", role: "user", created: 5 }),
          [createTextPart("user-2", "next")],
        ),
      ];

      syncMessages(store, clock, canonicalMessages);
      persistMark({
        store,
        markID: "mark-keep-1",
        toolCallMessageID: "mark-tool-1",
        route: "keep",
        createdAtMs: clock.tick(),
        sourceMessages: [
          { hostMessageID: "assistant-1" },
          { hostMessageID: "tool-1" },
        ],
      });

      const result = await runCompactionBatch({
        store,
        lockDirectory,
        sessionID: store.sessionID,
        promptText: "Summarize the selected canonical span.",
        models: ["model-keep"],
        transport: createSafeTransport(async (request) => {
          assert.equal(request.input.route, "keep");
          assert.deepEqual(
            request.input.sourceMessages.map(
              (message) => message.hostMessageID,
            ),
            ["assistant-1", "tool-1"],
          );
          return { contentText: "Compressed summary." };
        }),
        loadCanonicalSourceMessages: createCanonicalLoader({
          "assistant-1": "draft",
          "tool-1": "tool output",
        }),
        now: () => clock.tick(),
      });

      assert.equal(result.started, true);
      if (!result.started) {
        assert.fail("expected keep-route compaction to start");
      }

      assert.equal(result.finalStatus, "succeeded");
      assert.equal(result.jobs[0]?.replacement?.route, "keep");

      const transform = createMessagesTransformHook({
        pluginDirectory: projectDirectory,
      });
      const output = {
        messages: canonicalMessages.map((message) => structuredClone(message)),
      } satisfies MessagesTransformOutput;

      await transform({}, output);
      const firstProjection = JSON.stringify(output.messages);
      await transform({}, output);

      assert.equal(JSON.stringify(output.messages), firstProjection);
      assert.deepEqual(output.messages.map(readText), [
        `[compressible_000001_${computeVisibleChecksum("user-1")}] hello`,
        `[referable_000002_${computeVisibleChecksum("assistant-1")}] Compressed summary.`,
        `[compressible_000005_${computeVisibleChecksum("user-2")}] next`,
      ]);
      assert.deepEqual(
        querySqlite(
          store.databasePath,
          "SELECT route || '|' || status || '|' || COALESCE(content_text, '') FROM replacements ORDER BY replacement_id;",
        ),
        ["keep|committed|Compressed summary."],
      );
      assert.deepEqual(
        querySqlite(
          store.databasePath,
          "SELECT mark_id || '|' || status FROM marks ORDER BY mark_id;",
        ),
        ["mark-keep-1|consumed"],
      );
      assert.deepEqual(
        querySqlite(
          store.databasePath,
          "SELECT status FROM compaction_batches ORDER BY batch_id;",
        ),
        ["succeeded"],
      );
    },
  );
});

test("send-entry gate waits on the live lock and resumes from persisted batch state", async () => {
  await withTempEnvironment(
    async ({ projectDirectory, lockDirectory, store, clock }) => {
      seedActiveMarkSet(store, clock, ["mark-lock-1"]);

      const batchID = `batch-lock-${clock.tick()}`;
      const frozen = await runFrozenBatch(store, lockDirectory, batchID);

      assert.equal(frozen.started, true);
      if (!frozen.started) {
        assert.fail("expected frozen keep batch to start");
      }

      store.updateCompactionBatchStatus({
        batchID: frozen.persistedBatch.batchID,
        status: "running",
      });

      await guardToolExecutionDuringLock({
        pluginDirectory: projectDirectory,
        sessionID: store.sessionID,
        toolName: "read",
      });

      const waitPromise = waitForOrdinaryChatGateIfNeeded({
        pluginDirectory: projectDirectory,
        sessionID: store.sessionID,
        pollIntervalMs: 1,
      });

      const settle = delay(10).then(async () => {
        store.updateCompactionBatchStatus({
          batchID: frozen.persistedBatch.batchID,
          status: "succeeded",
        });
        await releaseSessionFileLock({
          lockDirectory,
          sessionID: store.sessionID,
        });
      });

      const outcome = await waitPromise;
      await settle;

      assert.deepEqual(outcome, {
        outcome: "succeeded",
        source: "compaction-batch",
      });
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
    join(tmpdir(), "opencode-context-compression-e2e-keep-"),
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

async function runFrozenBatch(
  store: SqliteSessionStateStore,
  lockDirectory: string,
  batchID: string,
) {
  const { freezeCurrentCompactionBatch } =
    await import("../../src/marks/batch-freeze.js");
  return freezeCurrentCompactionBatch({
    store,
    lockDirectory,
    sessionID: store.sessionID,
    batchID,
  });
}

function seedActiveMarkSet(
  store: SqliteSessionStateStore,
  clock: ReturnType<typeof createClock>,
  markIDs: readonly string[],
): void {
  store.syncCanonicalHostMessages({
    revision: `rev-lock-${clock.tick()}`,
    syncedAtMs: clock.current,
    messages: [
      hostMessage("src-1", "canon-src-1", "assistant"),
      hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
    ],
  });

  for (const [index, markID] of markIDs.entries()) {
    persistMark({
      store,
      markID,
      toolCallMessageID: `mark-tool-${index + 1}`,
      route: "keep",
      createdAtMs: clock.tick(),
      sourceMessages: [{ hostMessageID: "src-1" }],
    });
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

function hostMessage(
  hostMessageID: string,
  canonicalMessageID: string,
  role: string,
) {
  return {
    hostMessageID,
    canonicalMessageID,
    role,
  };
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

function parseObservationLog(serialized: string): Array<{
  seam: string;
  identityFields: Array<{ path: string; value: string }>;
}> {
  return serialized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          seam: string;
          identityFields: Array<{ path: string; value: string }>;
        },
    );
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
