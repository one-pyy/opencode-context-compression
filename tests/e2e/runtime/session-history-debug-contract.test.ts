import assert from "node:assert/strict";
import test from "node:test";

import type { Message, Part, ToolPart } from "@opencode-ai/sdk";

import {
  buildReplayHistorySourcesFromSessionMessages,
} from "../../../src/runtime/session-history.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "session history keeps compression_mark debug call outcomes while replaying only accepted mark intents",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "session history debug contract",
    });

    const sessionMessages = [
      createTextEnvelope({
        sessionID: fixture.sessionID,
        id: "msg-user-1",
        role: "user",
        created: 1,
        text: "Please compress the earlier tool chatter.",
      }),
      createToolCarrierEnvelope({
        sessionID: fixture.sessionID,
        id: "msg-assistant-1",
        created: 2,
        toolParts: [
          createCompletedCompressionMarkPart({
            sessionID: fixture.sessionID,
            messageID: "msg-assistant-1",
            partID: "tool-accepted",
            callID: "call-accepted",
            input: {
              mode: "compact",
              from: "compressible_000001_a1",
              to: "compressible_000002_a2",
            },
            output: JSON.stringify({
              ok: true,
              markId: "mark_accepted_001",
            }),
          }),
          createCompletedCompressionMarkPart({
            sessionID: fixture.sessionID,
            messageID: "msg-assistant-1",
            partID: "tool-rejected",
            callID: "call-rejected",
            input: {
              mode: "delete",
              from: "compressible_000003_b1",
              to: "compressible_000004_b2",
            },
            output: JSON.stringify({
              ok: false,
              errorCode: "DELETE_NOT_ALLOWED",
              message:
                "compression_mark mode='delete' is blocked by the current delete-admission policy.",
            }),
          }),
          createCompletedCompressionMarkPart({
            sessionID: fixture.sessionID,
            messageID: "msg-assistant-1",
            partID: "tool-invalid-input",
            callID: "call-invalid-input",
            input: {
              mode: "compact",
              target: [
                {
                  startVisibleMessageID: "compressible_000005_c1",
                  endVisibleMessageID: "compressible_000006_c2",
                },
              ],
            },
            output: JSON.stringify({
              ok: true,
              markId: "mark_should_not_replay",
            }),
          }),
          createCompletedCompressionMarkPart({
            sessionID: fixture.sessionID,
            messageID: "msg-assistant-1",
            partID: "tool-invalid-result",
            callID: "call-invalid-result",
            input: {
              mode: "compact",
              from: "compressible_000007_d1",
              to: "compressible_000008_d2",
            },
            output: "not-json",
          }),
        ],
      }),
    ];

    const replaySources = await buildReplayHistorySourcesFromSessionMessages({
      sessionId: fixture.sessionID,
      readSessionMessages: async () => sessionMessages,
    });

    assert.deepEqual(
      replaySources.toolHistory.map((entry) => ({
        sequence: entry.sequence,
        markId: entry.result.ok ? entry.result.markId : null,
        mode: entry.input.mode,
      })),
      [
        {
          sequence: 3,
          markId: "mark_accepted_001",
          mode: "compact",
        },
      ],
    );
    const compressionMarkToolCalls = replaySources.compressionMarkToolCalls ?? [];

    assert.deepEqual(
      compressionMarkToolCalls.map((entry) => ({
        sequence: entry.sequence,
        outcome: entry.outcome,
        mode: entry.mode,
        errorCode: entry.errorCode,
      })),
      [
        {
          sequence: 3,
          outcome: "accepted",
          mode: "compact",
          errorCode: undefined,
        },
        {
          sequence: 4,
          outcome: "rejected",
          mode: "delete",
          errorCode: "DELETE_NOT_ALLOWED",
        },
        {
          sequence: 5,
          outcome: "invalid-input",
          mode: undefined,
          errorCode: "INVALID_RANGE",
        },
        {
          sequence: 6,
          outcome: "invalid-result",
          mode: "compact",
          errorCode: "COMPACTION_FAILED",
        },
      ],
    );
  },
);

function createTextEnvelope(input: {
  readonly sessionID: string;
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly created: number;
  readonly text: string;
}): { info: Message; parts: Part[] } {
  return {
    info: {
      id: input.id,
      sessionID: input.sessionID,
      role: input.role,
      time: { created: input.created },
      agent: "atlas",
      model: {
        providerID: "openai.right",
        modelID: "gpt-5.4-mini",
      },
    } as Message,
    parts: [
      {
        id: `${input.id}:text`,
        sessionID: input.sessionID,
        messageID: input.id,
        type: "text" as const,
        text: input.text,
      },
    ],
  };
}

function createToolCarrierEnvelope(input: {
  readonly sessionID: string;
  readonly id: string;
  readonly created: number;
  readonly toolParts: ToolPart[];
}): { info: Message; parts: Part[] } {
  return {
    info: createMessageInfo({
      sessionID: input.sessionID,
      id: input.id,
      role: "assistant",
      created: input.created,
    }),
    parts: input.toolParts,
  };
}

function createMessageInfo(input: {
  readonly sessionID: string;
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly created: number;
}): Message {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: input.role,
    time: { created: input.created },
    agent: "atlas",
    model: {
      providerID: "openai.right",
      modelID: "gpt-5.4-mini",
    },
  } as Message;
}

function createCompletedCompressionMarkPart(input: {
  readonly sessionID: string;
  readonly messageID: string;
  readonly partID: string;
  readonly callID: string;
  readonly input: unknown;
  readonly output: string;
}): ToolPart {
  return {
    id: input.partID,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    tool: "compression_mark",
    callID: input.callID,
    state: {
      status: "completed",
      input: input.input,
      output: input.output,
    },
  } as ToolPart;
}
