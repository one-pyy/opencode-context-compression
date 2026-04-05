import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CompactionTransportInvocationError,
  runCompactionBatch,
  type CompactionRunnerTransport,
} from "../../src/compaction/runner.js";
import { persistMark } from "../../src/marks/mark-service.js";
import { readSessionFileLock } from "../../src/runtime/file-lock.js";
import {
  createSqliteSessionStateStore,
  type SqliteSessionStateStore,
} from "../../src/state/store.js";

test("runCompactionBatch falls back across the ordered model array and commits the successful delete result", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    seedDeleteMark(store, clock, "mark-delete-1");
    const seenModels: string[] = [];
    const transport = createSafeTransport(async (request) => {
      seenModels.push(request.model);
      assert.equal(request.input.promptContext, "dedicated-compaction-prompt");
      assert.deepEqual(
        request.input.sourceMessages.map((message) => message.hostMessageID),
        ["src-1", "src-2"],
      );

      if (request.model === "model-primary") {
        return { contentText: "   " };
      }

      return { contentText: "Deleted source span notice." };
    });

    const result = await runCompactionBatch({
      store,
      lockDirectory,
      sessionID: store.sessionID,
      promptText: "Produce a delete compaction result.",
      models: ["model-primary", "model-fallback"],
      transport,
      loadCanonicalSourceMessages: createCanonicalLoader({
        "src-1": "Assistant content.",
        "src-2": "Tool content.",
      }),
      now: () => clock.tick(),
    });

    assert.equal(result.started, true);
    if (!result.started) {
      assert.fail("expected the compaction batch to start");
    }

    assert.equal(result.finalStatus, "succeeded");
    assert.equal(result.batch.status, "succeeded");
    assert.deepEqual(seenModels, ["model-primary", "model-fallback"]);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0]?.job.status, "succeeded");
    assert.equal(result.jobs[0]?.replacement?.executionMode, "delete");
    assert.equal(
      result.jobs[0]?.replacement?.contentText,
      "Deleted source span notice.",
    );
    assert.deepEqual(
      result.jobs[0]?.attempts.map((attempt) => [
        attempt.modelName,
        attempt.status,
        attempt.errorCode ?? null,
      ]),
      [
        ["model-primary", "failed", "transport-response-invalid"],
        ["model-fallback", "succeeded", null],
      ],
    );
    assert.equal(store.getMark("mark-delete-1")?.status, "consumed");
    assert.equal(
      store.findLatestCommittedReplacementForMark("mark-delete-1")?.executionMode,
      "delete",
    );

    const lockState = await readSessionFileLock({
      lockDirectory,
      sessionID: store.sessionID,
      now: () => clock.current,
    });
    assert.equal(lockState.kind, "unlocked");
  });
});

test("runCompactionBatch uses mark mode for execution intent instead of inferring delete from allowDelete", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    seedKeepMark(store, clock, "mark-keep-mode-1", { allowDelete: true });
    const seenExecutionModes: string[] = [];
    const transport = createSafeTransport(async (request) => {
      seenExecutionModes.push(request.input.executionMode);
      return { contentText: "Compacted despite delete permission." };
    });

    const result = await runCompactionBatch({
      store,
      lockDirectory,
      sessionID: store.sessionID,
      promptText: "Produce a compact result.",
      models: ["model-only"],
      transport,
      loadCanonicalSourceMessages: createCanonicalLoader({
        "src-1": "Assistant content.",
        "src-2": "Tool content.",
      }),
      now: () => clock.tick(),
    });

    assert.equal(result.started, true);
    if (!result.started) {
      assert.fail("expected the compaction batch to start");
    }

    assert.deepEqual(seenExecutionModes, ["compact"]);
    assert.equal(result.jobs[0]?.replacement?.executionMode, "compact");
  });
});

test("runCompactionBatch preserves marks and clears the lock when the full model chain fails", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    seedKeepMark(store, clock, "mark-keep-1");
    const transport = createSafeTransport(async () => {
      throw new CompactionTransportInvocationError(
        "unavailable",
        "provider unavailable",
      );
    });

    const result = await runCompactionBatch({
      store,
      lockDirectory,
      sessionID: store.sessionID,
      promptText: "Produce a keep compaction result.",
      models: ["model-a", "model-b"],
      transport,
      loadCanonicalSourceMessages: createCanonicalLoader({
        "src-1": "Assistant content.",
        "src-2": "Tool content.",
      }),
      now: () => clock.tick(),
    });

    assert.equal(result.started, true);
    if (!result.started) {
      assert.fail("expected the compaction batch to start");
    }

    assert.equal(result.finalStatus, "failed");
    assert.equal(result.batch.status, "failed");
    assert.equal(result.jobs[0]?.job.status, "failed");
    assert.equal(result.jobs[0]?.finalFailure?.code, "transport-unavailable");
    assert.deepEqual(
      result.jobs[0]?.attempts.map((attempt) => attempt.errorCode),
      ["transport-unavailable", "transport-unavailable"],
    );
    assert.equal(store.getMark("mark-keep-1")?.status, "active");
    assert.equal(
      store.findLatestCommittedReplacementForMark("mark-keep-1"),
      undefined,
    );

    const lockState = await readSessionFileLock({
      lockDirectory,
      sessionID: store.sessionID,
      now: () => clock.current,
    });
    assert.equal(lockState.kind, "unlocked");
  });
});

test("runCompactionBatch revalidates source identity before commit and refuses stale canonical input", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    seedKeepMark(store, clock, "mark-keep-2");
    const transport = createSafeTransport(async () => {
      store.syncCanonicalHostMessages({
        revision: "rev-runner-revalidation-2",
        syncedAtMs: clock.tick(),
        messages: [
          hostMessage("src-1", "canon-src-1", "assistant"),
          hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
        ],
      });

      return { contentText: "Late summary that must not commit." };
    });

    const result = await runCompactionBatch({
      store,
      lockDirectory,
      sessionID: store.sessionID,
      promptText: "Produce a keep compaction result.",
      models: ["model-only"],
      transport,
      loadCanonicalSourceMessages: createCanonicalLoader({
        "src-1": "Assistant content.",
        "src-2": "Tool content.",
      }),
      now: () => clock.tick(),
    });

    assert.equal(result.started, true);
    if (!result.started) {
      assert.fail("expected the compaction batch to start");
    }

    assert.equal(result.finalStatus, "failed");
    assert.equal(result.jobs[0]?.job.status, "failed");
    assert.equal(
      result.jobs[0]?.finalFailure?.code,
      "source-revalidation-failed",
    );
    assert.equal(result.jobs[0]?.attempts.length, 1);
    assert.equal(
      result.jobs[0]?.attempts[0]?.errorCode,
      "source-revalidation-failed",
    );
    assert.equal(store.getMark("mark-keep-2")?.status, "active");
    assert.equal(
      store.findLatestCommittedReplacementForMark("mark-keep-2"),
      undefined,
    );

    const lockState = await readSessionFileLock({
      lockDirectory,
      sessionID: store.sessionID,
      now: () => clock.current,
    });
    assert.equal(lockState.kind, "unlocked");
  });
});

test("runCompactionBatch ignores late results from a job that already reached a newer terminal state", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    seedKeepMark(store, clock, "mark-keep-3");
    const transport = createSafeTransport(async (request) => {
      store.updateCompactionJobStatus({
        jobID: request.jobID,
        status: "failed",
        finishedAtMs: clock.tick(),
        finalErrorCode: "superseded",
        finalErrorText: "A newer terminal state already settled this job.",
      });

      return { contentText: "This late result must be ignored." };
    });

    const result = await runCompactionBatch({
      store,
      lockDirectory,
      sessionID: store.sessionID,
      promptText: "Produce a keep compaction result.",
      models: ["model-only"],
      transport,
      loadCanonicalSourceMessages: createCanonicalLoader({
        "src-1": "Assistant content.",
        "src-2": "Tool content.",
      }),
      now: () => clock.tick(),
    });

    assert.equal(result.started, true);
    if (!result.started) {
      assert.fail("expected the compaction batch to start");
    }

    assert.equal(result.finalStatus, "failed");
    assert.equal(result.jobs[0]?.job.status, "failed");
    assert.equal(result.jobs[0]?.job.finalErrorCode, "superseded");
    assert.equal(result.jobs[0]?.finalFailure?.code, "stale-attempt-result");
    assert.equal(result.jobs[0]?.attempts.length, 0);
    assert.equal(store.getMark("mark-keep-3")?.status, "active");
    assert.equal(
      store.findLatestCommittedReplacementForMark("mark-keep-3"),
      undefined,
    );
  });
});

test("runCompactionBatch treats missing opaque placeholders as a hard output error and never commits a partial result", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    seedKeepMark(store, clock, "mark-keep-opaque-1");
    persistCommittedCompactReplacement(store, clock, {
      markID: "mark-inner-opaque-1",
      toolCallMessageID: "mark-tool-inner-opaque-1",
      sourceMessages: [{ hostMessageID: "src-2" }],
      contentText: "Inner compact block.",
    });

    const seenRequiredPlaceholders: string[][] = [];
    const seenModels: string[] = [];
    const transport = createSafeTransport(async (request) => {
      seenModels.push(request.model);
      seenRequiredPlaceholders.push([...request.input.requiredPlaceholders]);
      if (seenModels.length <= 2) {
        return { contentText: "Dropped the opaque block entirely." };
      }

      return {
        contentText:
          "Summary before [[OPAQUE_SLOT_S1]] summary after.",
      };
    });

    const result = await runCompactionBatch({
      store,
      lockDirectory,
      sessionID: store.sessionID,
      promptText: "Produce a compact result.",
      models: ["model-primary", "model-fallback"],
      transport,
      loadCanonicalSourceMessages: createCanonicalLoader({
        "src-1": "Assistant content.",
        "src-2": "Tool content.",
      }),
      now: () => clock.tick(),
    });

    assert.equal(result.started, true);
    if (!result.started) {
      assert.fail("expected the compaction batch to start");
    }

    assert.deepEqual(seenRequiredPlaceholders, [
      ["[[OPAQUE_SLOT_S1]]"],
      ["[[OPAQUE_SLOT_S1]]"],
      ["[[OPAQUE_SLOT_S1]]"],
    ]);
    assert.deepEqual(seenModels, [
      "model-primary",
      "model-primary",
      "model-fallback",
    ]);
    assert.equal(result.jobs[0]?.job.status, "succeeded");
    assert.deepEqual(
      result.jobs[0]?.attempts.map((attempt) => attempt.errorCode ?? null),
      ["missing-required-placeholders", "missing-required-placeholders", null],
    );
    assert.equal(
      result.jobs[0]?.replacement?.contentText,
      "Summary before Inner compact block. summary after.",
    );
  });
});

test("runCompactionBatch rejects transports that violate the validated independent transport contract", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    seedKeepMark(store, clock, "mark-keep-4");
    const transport: CompactionRunnerTransport = {
      candidate: {
        id: "session.prompt",
        owner: "session",
        entrypoint: "session.prompt",
        promptContext: "session-prompt-input",
        sessionEffects: {
          createsUserMessage: true,
          reusesSharedLoop: true,
          dependsOnBusyState: true,
          mutatesPermissions: true,
        },
        failureClassification: "ambient-session-errors",
      },
      async invoke() {
        return { contentText: "unreachable" };
      },
    };

    const result = await runCompactionBatch({
      store,
      lockDirectory,
      sessionID: store.sessionID,
      promptText: "Produce a keep compaction result.",
      models: ["model-only"],
      transport,
      loadCanonicalSourceMessages: createCanonicalLoader({
        "src-1": "Assistant content.",
        "src-2": "Tool content.",
      }),
      now: () => clock.tick(),
    });

    if (result.started !== false || result.reason !== "invalid-transport") {
      assert.fail("expected invalid transport result");
    }

    assert.equal(result.assessment.safeDefault, false);
    assert.equal(result.failure.code, "transport-contract-violation");
    assert.equal(store.getCompactionBatch("test-session:batch:3"), undefined);
  });
});

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

function seedKeepMark(
  store: SqliteSessionStateStore,
  clock: ReturnType<typeof createClock>,
  markID: string,
  options?: { readonly allowDelete?: boolean },
): void {
  seedMark(store, clock, markID, "keep", options);
}

function seedDeleteMark(
  store: SqliteSessionStateStore,
  clock: ReturnType<typeof createClock>,
  markID: string,
): void {
  seedMark(store, clock, markID, "delete");
}

function seedMark(
  store: SqliteSessionStateStore,
  clock: ReturnType<typeof createClock>,
  markID: string,
  executionMode: "keep" | "delete",
  options?: { readonly allowDelete?: boolean },
): void {
  store.syncCanonicalHostMessages({
    revision: `rev-${markID}`,
    syncedAtMs: clock.tick(),
    messages: [
      hostMessage("src-1", "canon-src-1", "assistant"),
      hostMessage("src-2", "canon-src-2", "tool"),
      hostMessage("mark-tool-1", "canon-mark-tool-1", "tool"),
    ],
  });

  persistMark({
    store,
    markID,
    toolCallMessageID: "mark-tool-1",
    allowDelete: options?.allowDelete ?? executionMode === "delete",
    createdAtMs: clock.tick(),
    metadata: {
      mode: executionMode === "delete" ? "delete" : "compact",
    },
    sourceMessages: [{ hostMessageID: "src-1" }, { hostMessageID: "src-2" }],
  });
}

function persistCommittedCompactReplacement(
  store: SqliteSessionStateStore,
  clock: ReturnType<typeof createClock>,
  input: {
    readonly markID: string;
    readonly toolCallMessageID: string;
    readonly sourceMessages: readonly { hostMessageID: string }[];
    readonly contentText: string;
  },
): void {
  const currentMessages = store.listHostMessages({ presentOnly: true }).map((message) => ({
    hostMessageID: message.hostMessageID,
    canonicalMessageID: message.canonicalMessageID,
    role: message.role,
    hostCreatedAtMs: message.hostCreatedAtMs,
  }));
  store.syncCanonicalHostMessages({
    revision: `rev-${input.markID}`,
    syncedAtMs: clock.tick(),
    messages: [
      ...currentMessages,
      hostMessage(input.toolCallMessageID, input.toolCallMessageID, "tool"),
    ],
  });

  persistMark({
    store,
    markID: input.markID,
    toolCallMessageID: input.toolCallMessageID,
    allowDelete: true,
    createdAtMs: clock.tick(),
    metadata: { mode: "compact" },
    sourceMessages: input.sourceMessages,
  });

  store.commitReplacement({
    replacementID: `${input.markID}:replacement`,
    allowDelete: true,
    executionMode: "compact",
    committedAtMs: clock.tick(),
    contentText: input.contentText,
    markIDs: [input.markID],
    sourceSnapshot: {
      messages: input.sourceMessages.map((message) => ({
        hostMessageID: message.hostMessageID,
        role: message.hostMessageID === "src-2" ? "tool" : "assistant",
      })),
    },
  });
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

async function withTempEnvironment(
  run: (context: {
    store: SqliteSessionStateStore;
    clock: ReturnType<typeof createClock>;
    lockDirectory: string;
  }) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-compaction-runner-"),
  );
  const lockDirectory = join(pluginDirectory, "locks");
  const clock = createClock();
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "test-session",
    now: () => clock.current,
  });

  try {
    await run({ store, clock, lockDirectory });
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
