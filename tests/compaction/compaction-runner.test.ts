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
import { createSqliteSessionStateStore, type SqliteSessionStateStore } from "../../src/state/store.js";

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
    assert.equal(result.jobs[0]?.replacement?.route, "delete");
    assert.equal(result.jobs[0]?.replacement?.contentText, "Deleted source span notice.");
    assert.deepEqual(
      result.jobs[0]?.attempts.map((attempt) => [attempt.modelName, attempt.status, attempt.errorCode ?? null]),
      [
        ["model-primary", "failed", "transport-response-invalid"],
        ["model-fallback", "succeeded", null],
      ],
    );
    assert.equal(store.getMark("mark-delete-1")?.status, "consumed");
    assert.equal(store.findFirstCommittedReplacementForMark("mark-delete-1")?.route, "delete");

    const lockState = await readSessionFileLock({
      lockDirectory,
      sessionID: store.sessionID,
      now: () => clock.current,
    });
    assert.equal(lockState.kind, "unlocked");
  });
});

test("runCompactionBatch preserves marks and clears the lock when the full model chain fails", async () => {
  await withTempEnvironment(async ({ store, clock, lockDirectory }) => {
    seedKeepMark(store, clock, "mark-keep-1");
    const transport = createSafeTransport(async () => {
      throw new CompactionTransportInvocationError("unavailable", "provider unavailable");
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
    assert.equal(store.findFirstCommittedReplacementForMark("mark-keep-1"), undefined);

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
    assert.equal(result.jobs[0]?.finalFailure?.code, "source-revalidation-failed");
    assert.equal(result.jobs[0]?.attempts.length, 1);
    assert.equal(result.jobs[0]?.attempts[0]?.errorCode, "source-revalidation-failed");
    assert.equal(store.getMark("mark-keep-2")?.status, "active");
    assert.equal(store.findFirstCommittedReplacementForMark("mark-keep-2"), undefined);

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
    assert.equal(store.findFirstCommittedReplacementForMark("mark-keep-3"), undefined);
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
  return async ({ sourceMessages }: { sourceMessages: readonly { hostMessageID: string; canonicalMessageID: string; hostRole: string }[] }) =>
    sourceMessages.map((sourceMessage) => {
      const content = contentByHostMessageID[sourceMessage.hostMessageID];
      if (content === undefined) {
        throw new Error(`Missing canonical content for '${sourceMessage.hostMessageID}'.`);
      }

      return {
        hostMessageID: sourceMessage.hostMessageID,
        canonicalMessageID: sourceMessage.canonicalMessageID,
        role: sourceMessage.hostRole,
        content,
      };
    });
}

function seedKeepMark(store: SqliteSessionStateStore, clock: ReturnType<typeof createClock>, markID: string): void {
  seedMark(store, clock, markID, "keep");
}

function seedDeleteMark(store: SqliteSessionStateStore, clock: ReturnType<typeof createClock>, markID: string): void {
  seedMark(store, clock, markID, "delete");
}

function seedMark(
  store: SqliteSessionStateStore,
  clock: ReturnType<typeof createClock>,
  markID: string,
  route: "keep" | "delete",
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
    route,
    createdAtMs: clock.tick(),
    sourceMessages: [{ hostMessageID: "src-1" }, { hostMessageID: "src-2" }],
  });
}

function hostMessage(hostMessageID: string, canonicalMessageID: string, role: string) {
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
  const pluginDirectory = await mkdtemp(join(tmpdir(), "opencode-context-compression-compaction-runner-"));
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
