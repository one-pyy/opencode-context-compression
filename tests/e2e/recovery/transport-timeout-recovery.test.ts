import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCompactionInputBuilder } from "../../../src/compaction/input-builder.js";
import { createOutputValidator } from "../../../src/compaction/output-validation.js";
import { createContractLevelCompactionRunner } from "../../../src/compaction/runner.js";
import {
  CompactionTransportMalformedPayloadError,
  CompactionTransportTimeoutError,
  createScriptedCompactionTransport,
} from "../../../src/compaction/transport/index.js";
import {
  createCanonicalIdentityService,
} from "../../../src/identity/canonical-identity.js";
import {
  createHistoryReplayReaderFromSources,
  type CanonicalHostMessage,
} from "../../../src/history/history-replay-reader.js";
import { createFlatPolicyEngine } from "../../../src/projection/policy-engine.js";
import { createProjectionBuilder } from "../../../src/projection/projection-builder.js";
import { createStaticReminderService } from "../../../src/projection/reminder-service.js";
import { createSafeTransportAdapter } from "../../../src/runtime/compaction-transport.js";
import {
  resolvePluginStateDirectory,
  resolveSessionDatabasePath,
} from "../../../src/runtime/sidecar-layout.js";
import { createResultGroupRepository } from "../../../src/state/result-group-repository.js";
import {
  bootstrapSessionSidecar,
  openSessionSidecarRepository,
} from "../../../src/state/sidecar-store.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "transport timeout and malformed output leave zero committed result-group rows and preserve projection state",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "recovery",
      caseName: "transport timeout recovery failure cases",
    });
    const pluginDirectory = await mkdtemp(
      join(tmpdir(), "task11-recovery-transport-failure-"),
    );
    t.after(async () => {
      await rm(pluginDirectory, { force: true, recursive: true });
    });
    const stateDirectory = resolvePluginStateDirectory(pluginDirectory);
    const databasePath = resolveSessionDatabasePath(stateDirectory, fixture.sessionID);
    await rm(databasePath, { force: true });
    await bootstrapSessionSidecar({ databasePath });

    const sidecar = await openSessionSidecarRepository({ databasePath });
    t.after(() => sidecar.close());

    const resultGroups = createResultGroupRepository(sidecar);
    const identity = createCanonicalIdentityService({
      visibleIds: resultGroups,
      allocateAt: () => "2026-04-06T13:00:00.000Z",
    });

    const history = createRecoveryHistory();
    const visibleIds = await allocateHistoryVisibleIds(identity, history.hostHistory);
    const baselineProjection = await buildProjectionSnapshot({
      sessionId: fixture.sessionID,
      resultGroups,
      identity,
      hostHistory: history.hostHistory,
      toolHistory: [
        createCompactMarkToolEntry({
          sequence: 4,
          sourceMessageId: "tool-mark-timeout",
          markId: "mark-timeout-001",
          startVisibleMessageId: visibleIds.assistant1,
          endVisibleMessageId: visibleIds.tool1,
        }),
      ],
    });

    const timeoutTransport = createScriptedCompactionTransport([
      {
        kind: "timeout",
        timeoutMs: 8_000,
      },
    ]);
    const timeoutRunner = createRecoveryRunner(resultGroups, timeoutTransport);

    await assert.rejects(
      () =>
        timeoutRunner.run({
          build: createCompactRunInput({
            sessionId: fixture.sessionID,
            markId: "mark-timeout-001",
            transcript: createCompactTranscript(),
          }),
          maxAttemptsPerModel: 1,
          resultGroup: {
            sourceStartSeq: 2,
            sourceEndSeq: 3,
            createdAt: "2026-04-06T13:05:00.000Z",
            committedAt: "2026-04-06T13:05:01.000Z",
          },
        }),
      CompactionTransportTimeoutError,
    );

    assert.equal(await resultGroups.getCompleteGroup("mark-timeout-001"), null);
    assert.deepEqual(await readCommittedMarkCounts(resultGroups, "mark-timeout-001"), {
      groupCount: 0,
      fragmentCount: 0,
    });
    assert.deepEqual(
      await buildProjectionSnapshot({
        sessionId: fixture.sessionID,
        resultGroups,
        identity,
        hostHistory: history.hostHistory,
        toolHistory: [
          createCompactMarkToolEntry({
            sequence: 4,
            sourceMessageId: "tool-mark-timeout",
            markId: "mark-timeout-001",
            startVisibleMessageId: visibleIds.assistant1,
            endVisibleMessageId: visibleIds.tool1,
          }),
        ],
      }),
      baselineProjection,
    );

    const malformedTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: {
          wrongField: "missing contentText",
        },
      },
    ]);
    const malformedRunner = createRecoveryRunner(resultGroups, malformedTransport);

    await assert.rejects(
      () =>
        malformedRunner.run({
          build: createCompactRunInput({
            sessionId: fixture.sessionID,
            markId: "mark-malformed-001",
            transcript: createCompactTranscript(),
          }),
          maxAttemptsPerModel: 1,
          resultGroup: {
            sourceStartSeq: 2,
            sourceEndSeq: 3,
            createdAt: "2026-04-06T13:06:00.000Z",
            committedAt: "2026-04-06T13:06:01.000Z",
          },
        }),
      CompactionTransportMalformedPayloadError,
    );

    assert.equal(await resultGroups.getCompleteGroup("mark-malformed-001"), null);
    assert.deepEqual(
      await readCommittedMarkCounts(resultGroups, "mark-malformed-001"),
      {
      groupCount: 0,
      fragmentCount: 0,
      },
    );
    assert.deepEqual(
      await buildProjectionSnapshot({
        sessionId: fixture.sessionID,
        resultGroups,
        identity,
        hostHistory: history.hostHistory,
        toolHistory: [
          createCompactMarkToolEntry({
            sequence: 5,
            sourceMessageId: "tool-mark-malformed",
            markId: "mark-malformed-001",
            startVisibleMessageId: visibleIds.assistant1,
            endVisibleMessageId: visibleIds.tool1,
          }),
        ],
      }),
      baselineProjection,
    );

    const evidencePath = await fixture.evidence.writeJson(
      "transport-timeout-recovery-failure-cases",
      {
        baselineProjection,
        timeoutCalls: timeoutTransport.calls,
        malformedCalls: malformedTransport.calls,
        timeoutCounts: await readCommittedMarkCounts(
          resultGroups,
          "mark-timeout-001",
        ),
        malformedCounts: await readCommittedMarkCounts(
          resultGroups,
          "mark-malformed-001",
        ),
      },
    );
    assert.match(evidencePath, /transport-timeout-recovery-failure-cases\.json$/u);
  },
);

test(
  "retryable transport failure commits only after a later validated success and then updates projection once",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "recovery",
      caseName: "transport timeout recovery retry success",
    });
    const pluginDirectory = await mkdtemp(
      join(tmpdir(), "task11-recovery-transport-retry-"),
    );
    t.after(async () => {
      await rm(pluginDirectory, { force: true, recursive: true });
    });
    const stateDirectory = resolvePluginStateDirectory(pluginDirectory);
    const databasePath = resolveSessionDatabasePath(stateDirectory, fixture.sessionID);
    await rm(databasePath, { force: true });
    await bootstrapSessionSidecar({ databasePath });

    const sidecar = await openSessionSidecarRepository({ databasePath });
    t.after(() => sidecar.close());

    const resultGroups = createResultGroupRepository(sidecar);
    const identity = createCanonicalIdentityService({
      visibleIds: resultGroups,
      allocateAt: () => "2026-04-06T13:10:00.000Z",
    });

    const history = createRecoveryHistory();
    const visibleIds = await allocateHistoryVisibleIds(identity, history.hostHistory);
    const beforeProjection = await buildProjectionSnapshot({
      sessionId: fixture.sessionID,
      resultGroups,
      identity,
      hostHistory: history.hostHistory,
      toolHistory: [
        createCompactMarkToolEntry({
          sequence: 4,
          sourceMessageId: "tool-mark-retry",
          markId: "mark-retry-001",
          startVisibleMessageId: visibleIds.assistant1,
          endVisibleMessageId: visibleIds.tool1,
        }),
      ],
    });

    const scriptedTransport = createScriptedCompactionTransport([
      {
        kind: "retryable-error",
        message: "temporary transport saturation",
        code: "busy",
      },
      {
        kind: "success",
        rawPayload: {
          contentText: "Assistant and tool context were compacted into one stable summary.",
        },
      },
    ]);
    const runner = createRecoveryRunner(resultGroups, scriptedTransport);

    const result = await runner.run({
      build: createCompactRunInput({
        sessionId: fixture.sessionID,
        markId: "mark-retry-001",
        transcript: createCompactTranscript(),
      }),
      maxAttemptsPerModel: 2,
      resultGroup: {
        sourceStartSeq: 2,
        sourceEndSeq: 3,
        createdAt: "2026-04-06T13:11:00.000Z",
        committedAt: "2026-04-06T13:11:02.000Z",
      },
    });

    scriptedTransport.assertConsumed();
    assert.equal(result.validatedOutput.contentText, "Assistant and tool context were compacted into one stable summary.");
    assert.equal(scriptedTransport.calls.length, 2);
    assert.deepEqual(await readCommittedMarkCounts(resultGroups, "mark-retry-001"), {
      groupCount: 1,
      fragmentCount: 1,
    });

    const stored = await resultGroups.getCompleteGroup("mark-retry-001");
    assert.ok(stored);
    assert.equal(stored.mode, "compact");
    assert.equal(stored.fragmentCount, 1);
    assert.equal(stored.fragments[0]?.replacementText, result.validatedOutput.contentText);

    const afterProjection = await buildProjectionSnapshot({
      sessionId: fixture.sessionID,
      resultGroups,
      identity,
      hostHistory: history.hostHistory,
      toolHistory: [
        createCompactMarkToolEntry({
          sequence: 4,
          sourceMessageId: "tool-mark-retry",
          markId: "mark-retry-001",
          startVisibleMessageId: visibleIds.assistant1,
          endVisibleMessageId: visibleIds.tool1,
        }),
      ],
    });

    assert.notDeepEqual(afterProjection, beforeProjection);
    assert.equal(afterProjection.length, 2);
    assert.equal(afterProjection[0], beforeProjection[0]);
    assert.match(afterProjection[1] ?? "", /^\[referable_000002_[0-9A-Za-z]{8}\] Assistant and tool context were compacted into one stable summary\.$/u);
    assert.ok(
      scriptedTransport.calls[0]?.outcome.kind === "retryable-error" &&
        scriptedTransport.calls[1]?.outcome.kind === "success",
    );

    const evidencePath = await fixture.evidence.writeJson(
      "transport-timeout-recovery-retry-success",
      {
        beforeProjection,
        afterProjection,
        calls: scriptedTransport.calls,
        stored,
      },
    );
    assert.match(evidencePath, /transport-timeout-recovery-retry-success\.json$/u);
  },
);

function createRecoveryRunner(
  resultGroups: ReturnType<typeof createResultGroupRepository>,
  scriptedTransport: ReturnType<typeof createScriptedCompactionTransport>,
) {
  return createContractLevelCompactionRunner({
    inputBuilder: createCompactionInputBuilder(),
    transport: createSafeTransportAdapter(scriptedTransport.transport),
    outputValidator: createOutputValidator(),
    resultGroupRepository: resultGroups,
  });
}

function createRecoveryHistory() {
  return {
    hostHistory: [
      hostEntry(
        1,
        createMessage("msg-user-1", "user", "User question that still needs the assistant and tool context."),
      ),
      hostEntry(
        2,
        createMessage("msg-assistant-1", "assistant", "Assistant investigated the issue in detail."),
      ),
      hostEntry(
        3,
        createMessage("msg-tool-1", "tool", "Tool output with the diagnostic details that can later be compacted."),
      ),
    ] as const,
  };
}

async function allocateHistoryVisibleIds(
  identity: ReturnType<typeof createCanonicalIdentityService>,
  hostHistory: readonly ReturnType<typeof hostEntry>[],
) {
  const [user1, assistant1, tool1] = await Promise.all([
    identity.allocateVisibleId(hostHistory[0]!.message.info.id, "compressible"),
    identity.allocateVisibleId(hostHistory[1]!.message.info.id, "compressible"),
    identity.allocateVisibleId(hostHistory[2]!.message.info.id, "compressible"),
  ]);

  return {
    user1: user1.assignedVisibleId,
    assistant1: assistant1.assignedVisibleId,
    tool1: tool1.assignedVisibleId,
  };
}

async function buildProjectionSnapshot(input: {
  readonly sessionId: string;
  readonly resultGroups: ReturnType<typeof createResultGroupRepository>;
  readonly identity: ReturnType<typeof createCanonicalIdentityService>;
  readonly hostHistory: readonly ReturnType<typeof hostEntry>[];
  readonly toolHistory: readonly ReturnType<typeof createCompactMarkToolEntry>[];
}): Promise<string[]> {
  const projectionBuilder = createProjectionBuilder({
    historyReplayReader: createHistoryReplayReaderFromSources({
      sessionId: input.sessionId,
      hostHistory: input.hostHistory,
      toolHistory: input.toolHistory,
    }),
    policyEngine: createFlatPolicyEngine({
      smallUserMessageThreshold: 5,
    }),
    resultGroupRepository: input.resultGroups,
    canonicalIdentityService: input.identity,
    reminderService: createStaticReminderService(),
  });

  const projection = await projectionBuilder.build({
    sessionId: input.sessionId,
  });
  return projection.messages.map((message) => message.contentText);
}

function createCompactRunInput(input: {
  readonly sessionId: string;
  readonly markId: string;
  readonly transcript: ReturnType<typeof createCompactTranscript>;
}) {
  return {
    sessionId: input.sessionId,
    markId: input.markId,
    model: "model-primary",
    executionMode: "compact" as const,
    promptText: "Compress the selected assistant/tool span into one stable replacement.",
    timeoutMs: 8_000,
    transcript: input.transcript,
  };
}

function createCompactTranscript() {
  return [
    {
      role: "assistant" as const,
      hostMessageId: "msg-assistant-1",
      sourceStartSeq: 2,
      sourceEndSeq: 2,
      contentText: "Assistant investigated the issue in detail.",
    },
    {
      role: "tool" as const,
      hostMessageId: "msg-tool-1",
      sourceStartSeq: 3,
      sourceEndSeq: 3,
      contentText: "Tool output with the diagnostic details that can later be compacted.",
    },
  ] as const;
}

function createCompactMarkToolEntry(input: {
  readonly sequence: number;
  readonly sourceMessageId: string;
  readonly markId: string;
  readonly startVisibleMessageId: string;
  readonly endVisibleMessageId: string;
}) {
  return {
    sequence: input.sequence,
    sourceMessageId: input.sourceMessageId,
    toolName: "compression_mark" as const,
    input: {
      contractVersion: "v1" as const,
      mode: "compact" as const,
      target: {
        startVisibleMessageID: input.startVisibleMessageId,
        endVisibleMessageID: input.endVisibleMessageId,
      },
    },
    result: {
      ok: true as const,
      markId: input.markId,
    },
  };
}

async function readCommittedMarkCounts(
  resultGroups: ReturnType<typeof createResultGroupRepository>,
  markId: string,
) {
  const group = await resultGroups.getCompleteGroup(markId);
  return {
    groupCount: group ? 1 : 0,
    fragmentCount: group?.fragmentCount ?? 0,
  };
}

function hostEntry(sequence: number, message: CanonicalHostMessage) {
  return {
    sequence,
    message,
  };
}

function createMessage(
  id: string,
  role: "system" | "user" | "assistant" | "tool",
  text: string,
): CanonicalHostMessage {
  return {
    info: {
      id,
      role,
    },
    parts: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}
