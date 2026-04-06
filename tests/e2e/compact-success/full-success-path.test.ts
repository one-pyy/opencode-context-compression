import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCompactionRunInputForMark } from "../../../src/compaction/replay-run-input.js";
import { createCompactionInputBuilder } from "../../../src/compaction/input-builder.js";
import { createOutputValidator } from "../../../src/compaction/output-validation.js";
import { createContractLevelCompactionRunner } from "../../../src/compaction/runner.js";
import { createScriptedCompactionTransport } from "../../../src/compaction/transport/index.js";
import { createCanonicalIdentityService } from "../../../src/identity/canonical-identity.js";
import {
  createHistoryReplayReaderFromSources,
  type CanonicalHostMessage,
} from "../../../src/history/history-replay-reader.js";
import { createFlatPolicyEngine } from "../../../src/projection/policy-engine.js";
import { createProjectionBuilder } from "../../../src/projection/projection-builder.js";
import { createConfiguredReminderService } from "../../../src/projection/reminder-service.js";
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
import {
  createCompressionMarkAdmission,
  executeCompressionMark,
} from "../../../src/tools/compression-mark.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "full compact success path replays a mark into compaction input, commits one validated result group, and updates projection",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "compact-success",
      caseName: "full success path",
    });
    const pluginDirectory = await mkdtemp(join(tmpdir(), "task12-compact-success-"));
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
      allocateAt: () => "2026-04-06T16:00:00.000Z",
    });

    const history = createSuccessHistory();
    const initialProjection = await buildProjectionResult({
      sessionId: fixture.sessionID,
      resultGroups,
      identity,
      hostHistory: history.hostHistory,
      toolHistory: [],
    });

    const initialVisibleIds = {
      user1: initialProjection.state.messagePolicies[0]!.visibleId,
      assistant1: initialProjection.state.messagePolicies[1]!.visibleId,
      tool1: initialProjection.state.messagePolicies[2]!.visibleId,
      user2: initialProjection.state.messagePolicies[3]!.visibleId,
    };
    assert.deepEqual(
      initialProjection.messages.map((message) => message.contentText),
      [
        `[${initialVisibleIds.user1}] User asks for the error investigation summary.`,
        `[${initialVisibleIds.assistant1}] Assistant begins the investigation and explains the debugging plan.`,
        `[${initialVisibleIds.tool1}] Tool output includes the stack trace and environment details that can be compacted later.`,
        `[${initialVisibleIds.user2}] User asks for the concise outcome after the investigation.`,
      ],
    );
    assert.deepEqual(initialProjection.reminders, []);

    const markResult = await executeCompressionMark(
      {
        contractVersion: "v1",
        mode: "compact",
        target: {
          startVisibleMessageID: initialVisibleIds.assistant1,
          endVisibleMessageID: initialVisibleIds.tool1,
        },
      },
      createToolContext(fixture.sessionID),
      {
        admission: createCompressionMarkAdmission({ allowDelete: false }),
        createMarkID: () => "mark-compact-success-001",
      },
    );

    assert.deepEqual(markResult, {
      ok: true,
      markId: "mark-compact-success-001",
    });

    const toolHistory = [
      createCompactMarkToolEntry({
        sequence: 5,
        sourceMessageId: "tool-mark-compact-success",
        markId: "mark-compact-success-001",
        startVisibleMessageId: initialVisibleIds.assistant1,
        endVisibleMessageId: initialVisibleIds.tool1,
      }),
    ] as const;

    const beforeCommitProjection = await buildProjectionResult({
      sessionId: fixture.sessionID,
      resultGroups,
      identity,
      hostHistory: history.hostHistory,
      toolHistory,
    });
    assert.deepEqual(
      beforeCommitProjection.messages.map((message) => message.contentText),
      initialProjection.messages.map((message) => message.contentText),
    );
    assert.deepEqual(beforeCommitProjection.reminders, []);

    const runInput = buildCompactionRunInputForMark({
      sessionId: fixture.sessionID,
      state: beforeCommitProjection.state,
      markId: "mark-compact-success-001",
      model: "model-success-primary",
      promptText:
        "Compress the selected assistant and tool span into one concise, stable summary.",
      timeoutMs: 9_000,
      maxAttemptsPerModel: 1,
      createdAt: "2026-04-06T16:05:00.000Z",
      committedAt: "2026-04-06T16:05:01.000Z",
    });

    assert.deepEqual(runInput.build.transcript, [
      {
        role: "assistant",
        hostMessageId: "msg-assistant-1",
        canonicalMessageId: "msg-assistant-1",
        sourceStartSeq: 2,
        sourceEndSeq: 2,
        contentText:
          "Assistant begins the investigation and explains the debugging plan.",
      },
      {
        role: "tool",
        hostMessageId: "msg-tool-1",
        canonicalMessageId: "msg-tool-1",
        sourceStartSeq: 3,
        sourceEndSeq: 3,
        contentText:
          "Tool output includes the stack trace and environment details that can be compacted later.",
      },
    ]);

    const scriptedTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: {
          contentText:
            "Assistant investigated the issue, captured the stack trace, and isolated the environment mismatch as the likely cause.",
        },
        assertRequest(request, callIndex) {
          assert.equal(callIndex, 0);
          assert.equal(request.markID, "mark-compact-success-001");
          assert.equal(request.model, "model-success-primary");
          assert.equal(request.executionMode, "compact");
          assert.equal(request.transcript.length, 2);
          assert.equal(
            request.transcript[0]?.canonicalMessageID,
            "msg-assistant-1",
          );
          assert.equal(request.transcript[1]?.canonicalMessageID, "msg-tool-1");
        },
      },
    ]);
    const runner = createContractLevelCompactionRunner({
      inputBuilder: createCompactionInputBuilder(),
      transport: createSafeTransportAdapter(scriptedTransport.transport),
      outputValidator: createOutputValidator(),
      resultGroupRepository: resultGroups,
    });

    const result = await runner.run(runInput);

    scriptedTransport.assertConsumed();
    assert.equal(
      result.validatedOutput.contentText,
      "Assistant investigated the issue, captured the stack trace, and isolated the environment mismatch as the likely cause.",
    );

    const stored = await resultGroups.getCompleteGroup("mark-compact-success-001");
    assert.ok(stored);
    assert.deepEqual(stored, {
      markId: "mark-compact-success-001",
      mode: "compact",
      sourceStartSeq: 2,
      sourceEndSeq: 3,
      fragmentCount: 1,
      modelName: "model-success-primary",
      executionMode: "compact",
      createdAt: "2026-04-06T16:05:00.000Z",
      committedAt: "2026-04-06T16:05:01.000Z",
      payloadSha256: stored.payloadSha256,
      fragments: [
        {
          fragmentIndex: 0,
          sourceStartSeq: 2,
          sourceEndSeq: 3,
          replacementText:
            "Assistant investigated the issue, captured the stack trace, and isolated the environment mismatch as the likely cause.",
        },
      ],
    });

    const afterCommitProjection = await buildProjectionResult({
      sessionId: fixture.sessionID,
      resultGroups,
      identity,
      hostHistory: history.hostHistory,
      toolHistory,
    });

    assert.deepEqual(afterCommitProjection.reminders, []);
    assert.deepEqual(
      afterCommitProjection.messages.map((message) => message.contentText),
      [
        `[${initialVisibleIds.user1}] User asks for the error investigation summary.`,
        afterCommitProjection.messages[1]!.contentText,
        `[${initialVisibleIds.user2}] User asks for the concise outcome after the investigation.`,
      ],
    );
    assert.match(
      afterCommitProjection.messages[1]!.contentText,
      /^\[referable_000002_[0-9A-Za-z]{8}\] Assistant investigated the issue, captured the stack trace, and isolated the environment mismatch as the likely cause\.$/u,
    );

    const evidencePath = await fixture.evidence.writeJson("full-success-path", {
      initialProjection: initialProjection.messages.map((message) => message.contentText),
      beforeCommitProjection: beforeCommitProjection.messages.map((message) =>
        message.contentText,
      ),
      runInput,
      transportCalls: scriptedTransport.calls,
      stored,
      afterCommitProjection: afterCommitProjection.messages.map((message) =>
        message.contentText,
      ),
    });
    assert.match(evidencePath, /full-success-path\.json$/u);
  },
);

function createSuccessHistory() {
  return {
    hostHistory: [
      hostEntry(
        1,
        createMessage(
          "msg-user-1",
          "user",
          "User asks for the error investigation summary.",
        ),
      ),
      hostEntry(
        2,
        createMessage(
          "msg-assistant-1",
          "assistant",
          "Assistant begins the investigation and explains the debugging plan.",
        ),
      ),
      hostEntry(
        3,
        createMessage(
          "msg-tool-1",
          "tool",
          "Tool output includes the stack trace and environment details that can be compacted later.",
        ),
      ),
      hostEntry(
        4,
        createMessage(
          "msg-user-2",
          "user",
          "User asks for the concise outcome after the investigation.",
        ),
      ),
    ] as const,
  };
}

async function buildProjectionResult(input: {
  readonly sessionId: string;
  readonly resultGroups: ReturnType<typeof createResultGroupRepository>;
  readonly identity: ReturnType<typeof createCanonicalIdentityService>;
  readonly hostHistory: readonly ReturnType<typeof hostEntry>[];
  readonly toolHistory: readonly ReturnType<typeof createCompactMarkToolEntry>[];
}) {
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
    reminderService: createConfiguredReminderService({
      hsoft: 10_000,
      hhard: 20_000,
      softRepeatEveryTokens: 5_000,
      hardRepeatEveryTokens: 5_000,
      allowDelete: false,
      promptTextByKind: {
        "soft-compact": "soft compact reminder",
        "soft-delete": "soft delete reminder",
        "hard-compact": "hard compact reminder",
        "hard-delete": "hard delete reminder",
      },
    }),
  });

  return projectionBuilder.build({
    sessionId: input.sessionId,
  });
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

function createToolContext(sessionID: string) {
  return {
    sessionID,
    messageID: "assistant-turn-compact-success",
    agent: "atlas",
    directory: "/tmp/opencode-context-compression",
    worktree: "/tmp/opencode-context-compression",
    abort: new AbortController().signal,
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
