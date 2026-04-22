import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCompactionInputBuilder } from "../../../src/compaction/input-builder.js";
import { createOutputValidator } from "../../../src/compaction/output-validation.js";
import { createContractLevelCompactionRunner } from "../../../src/compaction/runner.js";
import { createScriptedCompactionTransport } from "../../../src/compaction/transport/index.js";
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
import {
  createCompressionMarkAdmission,
  executeCompressionMark,
} from "../../../src/tools/compression-mark.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "delete admission blocked returns a delete admission error and leaves projection plus sidecar free of committed delete results",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "recovery",
      caseName: "delete admission blocked",
    });
    const pluginDirectory = await mkdtemp(
      join(tmpdir(), "task11-recovery-delete-blocked-"),
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
      allocateAt: () => "2026-04-06T15:00:00.000Z",
    });
    const history = createDeleteHistory();
    const visibleIds = await allocateHistoryVisibleIds(identity, history.hostHistory);

    const blockedResult = await executeCompressionMark(
      {
        mode: "delete",
        from: visibleIds.assistant1,
        to: visibleIds.tool1,
      },
      createToolContext(fixture.sessionID),
      {
        admission: createCompressionMarkAdmission({ allowDelete: false }),
        createMarkID: () => "mark-delete-blocked-should-not-exist",
      },
    );

    assert.deepEqual(blockedResult, {
      ok: false,
      errorCode: "DELETE_NOT_ALLOWED",
      message:
        'compression_mark mode="delete" is not allowed in this session. Use mode="compact" instead to compress messages into summaries while preserving important information.',
    });

    const projection = await buildProjectionSnapshot({
      sessionId: fixture.sessionID,
      resultGroups,
      identity,
      hostHistory: history.hostHistory,
      toolHistory: [
        {
          sequence: 4,
          sourceMessageId: "tool-mark-delete-blocked",
          toolName: "compression_mark" as const,
          input: {
            mode: "delete" as const,
            from: visibleIds.assistant1,
            to: visibleIds.tool1,
          },
          result: blockedResult,
        },
      ],
    });

    assert.equal((await resultGroups.listGroupsOverlappingRange(1, 3)).length, 0);
    assert.deepEqual(await readCommittedRangeCounts(resultGroups, 1, 3), {
      groupCount: 0,
      fragmentCount: 0,
    });
    assert.deepEqual(projection, [
      `[${visibleIds.user1}] User asks whether the old diagnostic span can be removed.`,
      `[${visibleIds.assistant1}] Assistant produced removable reasoning.`,
      `[${visibleIds.tool1}] Tool output contains details that would be deleted if admission were allowed.`,
    ]);

    const evidencePath = await fixture.evidence.writeJson(
      "delete-admission-blocked",
      {
        blockedResult,
        projection,
        counts: await readCommittedRangeCounts(resultGroups, 1, 3),
      },
    );
    assert.match(evidencePath, /delete-admission-blocked\.json$/u);
  },
);

test(
  "delete admission allowed creates a real delete-style result group and projection renders the committed delete notice",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "recovery",
      caseName: "delete admission allowed",
    });
    const pluginDirectory = await mkdtemp(
      join(tmpdir(), "task11-recovery-delete-allowed-"),
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
      allocateAt: () => "2026-04-06T15:10:00.000Z",
    });
    const history = createDeleteHistory();
    const visibleIds = await allocateHistoryVisibleIds(identity, history.hostHistory);

    const allowedResult = await executeCompressionMark(
      {
        mode: "delete",
        from: visibleIds.assistant1,
        to: visibleIds.tool1,
      },
      createToolContext(fixture.sessionID),
      {
        admission: createCompressionMarkAdmission({ allowDelete: true }),
        createMarkID: () => "mark-delete-allowed-001",
      },
    );

    assert.deepEqual(allowedResult, {
      ok: true,
      markId: "mark-delete-allowed-001",
    });

    const beforeProjection = await buildProjectionSnapshot({
      sessionId: fixture.sessionID,
      resultGroups,
      identity,
      hostHistory: history.hostHistory,
      toolHistory: [
        createDeleteMarkToolEntry({
          sequence: 4,
          sourceMessageId: "tool-mark-delete-allowed",
          markId: "mark-delete-allowed-001",
          startVisibleMessageId: visibleIds.assistant1,
          endVisibleMessageId: visibleIds.tool1,
        }),
      ],
    });

    const scriptedTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: {
          contentText: "Delete notice: assistant reasoning and tool details were removed because they are no longer needed.",
        },
      },
    ]);
    const runner = createContractLevelCompactionRunner({
      inputBuilder: createCompactionInputBuilder(),
      transport: createSafeTransportAdapter(scriptedTransport.transport),
      outputValidator: createOutputValidator(),
      resultGroupRepository: resultGroups,
    });

    await runner.run({
      build: {
        sessionId: fixture.sessionID,
        markId: "mark-delete-allowed-001",
        model: "model-delete",
        executionMode: "delete",
        promptText: "Delete the selected span with a concise delete notice.",
        timeoutMs: 9_000,
        transcript: [
          {
            role: "assistant",
            hostMessageId: "msg-assistant-1",
            sourceStartSeq: 2,
            sourceEndSeq: 2,
            contentText: "Assistant produced removable reasoning.",
          },
          {
            role: "tool",
            hostMessageId: "msg-tool-1",
            sourceStartSeq: 3,
            sourceEndSeq: 3,
            contentText: "Tool output contains details that would be deleted if admission were allowed.",
          },
        ],
      },
      maxAttemptsPerModel: 1,
      resultGroup: {
        sourceStartSeq: 2,
        sourceEndSeq: 3,
        createdAt: "2026-04-06T15:11:00.000Z",
        committedAt: "2026-04-06T15:11:01.000Z",
      },
    });

    const stored = await resultGroups.getCompleteGroup("mark-delete-allowed-001");
    assert.ok(stored);
    assert.equal(stored.mode, "delete");
    assert.deepEqual(
      await readCommittedMarkCounts(resultGroups, "mark-delete-allowed-001"),
      {
      groupCount: 1,
      fragmentCount: 1,
      },
    );

    const afterProjection = await buildProjectionSnapshot({
      sessionId: fixture.sessionID,
      resultGroups,
      identity,
      hostHistory: history.hostHistory,
      toolHistory: [
        createDeleteMarkToolEntry({
          sequence: 4,
          sourceMessageId: "tool-mark-delete-allowed",
          markId: "mark-delete-allowed-001",
          startVisibleMessageId: visibleIds.assistant1,
          endVisibleMessageId: visibleIds.tool1,
        }),
      ],
    });

    assert.deepEqual(beforeProjection, [
      `[${visibleIds.user1}] User asks whether the old diagnostic span can be removed.`,
      `[${visibleIds.assistant1}] Assistant produced removable reasoning.`,
      `[${visibleIds.tool1}] Tool output contains details that would be deleted if admission were allowed.`,
    ]);
    assert.deepEqual(afterProjection, [
      `[${visibleIds.user1}] User asks whether the old diagnostic span can be removed.`,
      "Delete notice: assistant reasoning and tool details were removed because they are no longer needed.",
    ]);
    assert.doesNotMatch(afterProjection[1] ?? "", /^\[/u);

    const evidencePath = await fixture.evidence.writeJson(
      "delete-admission-allowed",
      {
        beforeProjection,
        afterProjection,
        stored,
        calls: scriptedTransport.calls,
      },
    );
    assert.match(evidencePath, /delete-admission-allowed\.json$/u);
  },
);

function createDeleteHistory() {
  return {
    hostHistory: [
      hostEntry(
        1,
        createMessage("msg-user-1", "user", "User asks whether the old diagnostic span can be removed."),
      ),
      hostEntry(
        2,
        createMessage("msg-assistant-1", "assistant", "Assistant produced removable reasoning."),
      ),
      hostEntry(
        3,
        createMessage("msg-tool-1", "tool", "Tool output contains details that would be deleted if admission were allowed."),
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
  readonly toolHistory: ReadonlyArray<ReturnType<typeof createDeleteMarkToolEntry> | {
      readonly sequence: number;
      readonly sourceMessageId: string;
      readonly toolName: "compression_mark";
      readonly input: {
        readonly mode: "delete";
        readonly from: string;
        readonly to: string;
      };
    readonly result: Awaited<ReturnType<typeof executeCompressionMark>>;
  }>;
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

function createDeleteMarkToolEntry(input: {
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
      mode: "delete" as const,
      from: input.startVisibleMessageId,
      to: input.endVisibleMessageId,
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
    messageID: "msg-tool-call",
    agent: "atlas",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
  };
}

async function readCommittedRangeCounts(
  resultGroups: ReturnType<typeof createResultGroupRepository>,
  startSeq: number,
  endSeq: number,
) {
  const groups = await resultGroups.listGroupsOverlappingRange(startSeq, endSeq);
  return {
    groupCount: groups.length,
    fragmentCount: groups.reduce(
      (total, group) => total + group.fragmentCount,
      0,
    ),
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
