import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createHistoryBackedChatParamsScheduler,
  createRuntimeChatParamsSchedulerService,
  CHAT_PARAMS_METADATA_KEY,
  createChatParamsSchedulerHook,
} from "../../../src/runtime/chat-params-scheduler.js";
import {
  acquireSessionFileLock,
  releaseSessionFileLock,
} from "../../../src/runtime/file-lock.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "chat.params freezes the active mark batch at dispatch and only writes narrow scheduler metadata",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "chat params scheduler",
    });
    const lockRoot = await mkdtemp(join(tmpdir(), "chat-params-scheduler-"));
    const lockDirectory = join(lockRoot, "locks");

    const firstHistory = [
      userEnvelope(fixture.sessionID, "msg-user-1", 1, "Please compress the earlier work."),
      assistantEnvelopeWithMark(
        fixture.sessionID,
        "msg-assistant-1",
        2,
        "mark-001",
        "msg-user-1",
        "msg-assistant-1",
      ),
    ];
    const secondHistory = [
      ...firstHistory,
      userEnvelope(
        fixture.sessionID,
        "msg-user-2",
        3,
        "Queue the next mark while the first batch is still running.",
      ),
      assistantEnvelopeWithMark(
        fixture.sessionID,
        "msg-assistant-2",
        4,
        "mark-002",
        "msg-user-2",
        "msg-assistant-2",
      ),
    ];

    let readCount = 0;
    let lockNowMs = 50;
    const dispatchedBatches: string[][] = [];
    const scheduler = createHistoryBackedChatParamsScheduler({
      lockDirectory,
      schedulerMarkThreshold: 1,
      now: () => "2026-04-06T12:00:00.000Z",
      readLockNow: () => lockNowMs,
      readSessionMessages: async () => {
        readCount += 1;
        return readCount === 1 ? firstHistory : secondHistory;
      },
      dispatch: async ({ eligibleMarkIds }) => {
        dispatchedBatches.push([...eligibleMarkIds]);
        await acquireSessionFileLock({
          lockDirectory,
          sessionID: fixture.sessionID,
          startedAtMs: lockNowMs,
          now: () => lockNowMs,
        });

        return {
          scheduled: true,
          reason: "froze the current replay-derived mark set for compaction dispatch",
          dispatchedBatch: {
            markIds: Object.freeze([...eligibleMarkIds]),
            markCount: eligibleMarkIds.length,
            dispatchedAt: "2026-04-06T12:00:00.000Z",
          },
        };
      },
    });
    const hook = createChatParamsSchedulerHook({
      scheduler: createRuntimeChatParamsSchedulerService({ scheduler }),
    });

    const output: {
      temperature: number;
      topP: number;
      topK: number;
      options: Record<string, unknown>;
    } = {
      temperature: 0.4,
      topP: 0.9,
      topK: 50,
      options: {
        existingFlag: true,
      },
    };

    await hook(
      createChatParamsInput(fixture.sessionID, "msg-chat-params-1"),
      output,
    );

    assert.deepEqual(dispatchedBatches, [["mark-001"]]);
    assert.equal(output.temperature, 0.4);
    assert.equal(output.topP, 0.9);
    assert.equal(output.topK, 50);
    assert.equal(output.options.existingFlag, true);
    assert.deepEqual(output.options[CHAT_PARAMS_METADATA_KEY], {
      contractVersion: "v1",
      schedulerState: "scheduled",
      scheduled: true,
      reason: "froze the current replay-derived mark set for compaction dispatch",
      activeCompactionLock: false,
      pendingMarkCount: 1,
      dispatchedBatch: {
        markIds: ["mark-001"],
        markCount: 1,
        dispatchedAt: "2026-04-06T12:00:00.000Z",
      },
    });

    const lockedOutput: {
      temperature: number;
      topP: number;
      topK: number;
      options: Record<string, unknown>;
    } = {
      temperature: 0.2,
      topP: 0.8,
      topK: 40,
      options: {},
    };

    await hook(
      createChatParamsInput(fixture.sessionID, "msg-chat-params-2"),
      lockedOutput,
    );

    assert.deepEqual(dispatchedBatches, [["mark-001"]]);
    assert.deepEqual(lockedOutput.options[CHAT_PARAMS_METADATA_KEY], {
      contractVersion: "v1",
      schedulerState: "eligible",
      scheduled: false,
      reason:
        "compaction is already running; newly replayed marks stay queued for the next batch",
      activeCompactionLock: true,
      pendingMarkCount: 2,
    });

    const flattened = JSON.stringify(lockedOutput.options);
    for (const forbiddenKey of [
      "messages",
      "projection",
      "renderedMessages",
      "reminder",
      "visibleIDs",
      "resultGroups",
    ]) {
      assert.doesNotMatch(flattened, new RegExp(`\"${forbiddenKey}\"`, "u"));
    }

    await releaseSessionFileLock({
      lockDirectory,
      sessionID: fixture.sessionID,
    });

    const evidencePath = await fixture.evidence.writeJson(
      "chat-params-scheduler",
      {
        dispatchedBatches,
        firstMetadata: output.options[CHAT_PARAMS_METADATA_KEY],
        secondMetadata: lockedOutput.options[CHAT_PARAMS_METADATA_KEY],
      },
    );
    assert.match(evidencePath, /chat-params-scheduler\.json$/u);
  },
);

function createChatParamsInput(sessionID: string, messageID: string) {
  return {
    sessionID,
    agent: "atlas",
    model: {
      id: "model-1",
      name: "gpt-5.4-mini",
      provider: "openai.right",
    } as never,
    provider: {
      source: "custom" as const,
      info: {} as never,
      options: {},
    },
    message: {
      id: messageID,
      sessionID,
      role: "user" as const,
      time: { created: 1 },
      agent: "atlas",
      model: {
        providerID: "openai.right",
        modelID: "gpt-5.4-mini",
      },
    },
  };
}

function userEnvelope(
  sessionID: string,
  messageID: string,
  created: number,
  text: string,
) {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user" as const,
      time: { created },
      agent: "atlas",
      model: {
        providerID: "openai.right",
        modelID: "gpt-5.4-mini",
      },
    },
    parts: [
      {
        id: `${messageID}:text`,
        sessionID,
        messageID,
        type: "text" as const,
        text,
      },
    ],
  };
}

function assistantEnvelopeWithMark(
  sessionID: string,
  messageID: string,
  created: number,
  markID: string,
  startVisibleMessageID: string,
  endVisibleMessageID: string,
) {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant" as const,
      time: { created, completed: created + 1 },
      parentID: messageID === "msg-assistant-1" ? "msg-user-1" : "msg-user-2",
      modelID: "gpt-5.4-mini",
      providerID: "openai.right",
      mode: "chat",
      path: {
        cwd: "/tmp",
        root: "/tmp",
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: `${messageID}:tool`,
        sessionID,
        messageID,
        type: "tool" as const,
        callID: `${markID}:call`,
        tool: "compression_mark",
        state: {
          status: "completed" as const,
          input: {
            contractVersion: "v1",
            mode: "compact",
            target: {
              startVisibleMessageID,
              endVisibleMessageID,
            },
          },
          output: JSON.stringify({ ok: true, markId: markID }),
          title: "compression_mark",
          metadata: {},
          time: {
            start: created,
            end: created + 1,
          },
        },
      },
    ],
  };
}
