import type { Message, Part, ToolPart } from "@opencode-ai/sdk";

import {
  createHistoryReplayReaderFromSources,
  type CanonicalHostMessage,
  type CanonicalHostMessagePart,
  type ReplayedCompressionMarkToolCall,
  type ReplayHistorySources,
  type ReplayableCompressionMarkToolEntry,
  type ReplayableHostHistoryEntry,
  type ReplayedHistory,
} from "../history/history-replay-reader.js";
import {
  deserializeCompressionMarkResult,
  validateCompressionMarkInput,
} from "../tools/compression-mark.js";

export interface SessionMessageEnvelope {
  readonly info: Message;
  readonly parts: readonly Part[];
}

export interface SessionHistoryReader {
  readSessionMessages(
    sessionId: string,
  ):
    | Promise<readonly SessionMessageEnvelope[]>
    | readonly SessionMessageEnvelope[];
}

export async function buildReplayedHistoryFromSessionMessages(input: {
  readonly sessionId: string;
  readonly readSessionMessages: SessionHistoryReader["readSessionMessages"];
}): Promise<ReplayedHistory> {
  return createHistoryReplayReaderFromSessionMessages({
    readSessionMessages: input.readSessionMessages,
  }).read(input.sessionId);
}

export function createHistoryReplayReaderFromSessionMessages(input: {
  readonly readSessionMessages: SessionHistoryReader["readSessionMessages"];
}) {
  return createHistoryReplayReaderFromSources(async (sessionId) =>
    buildReplayHistorySourcesFromSessionMessages({
      sessionId,
      readSessionMessages: input.readSessionMessages,
    }),
  );
}

export async function buildReplayHistorySourcesFromSessionMessages(input: {
  readonly sessionId: string;
  readonly readSessionMessages: SessionHistoryReader["readSessionMessages"];
}): Promise<ReplayHistorySources> {
  const envelopes = await input.readSessionMessages(input.sessionId);
  const replayEntries = collectReplayableEntries(envelopes);

  return {
    sessionId: input.sessionId,
    hostHistory: replayEntries.hostHistory,
    toolHistory: replayEntries.toolHistory,
    compressionMarkToolCalls: replayEntries.compressionMarkToolCalls,
  } satisfies ReplayHistorySources;
}

export function collectReplayableHostHistory(
  envelopes: readonly SessionMessageEnvelope[],
): readonly ReplayableHostHistoryEntry[] {
  return collectReplayableEntries(envelopes).hostHistory;
}

export function collectReplayableCompressionMarkHistory(
  envelopes: readonly SessionMessageEnvelope[],
): readonly ReplayableCompressionMarkToolEntry[] {
  return collectReplayableEntries(envelopes).toolHistory;
}

function collectReplayableEntries(
  envelopes: readonly SessionMessageEnvelope[],
): {
  readonly hostHistory: readonly ReplayableHostHistoryEntry[];
  readonly toolHistory: readonly ReplayableCompressionMarkToolEntry[];
  readonly compressionMarkToolCalls: readonly ReplayedCompressionMarkToolCall[];
} {
  const hostHistory: ReplayableHostHistoryEntry[] = [];
  const toolHistory: ReplayableCompressionMarkToolEntry[] = [];
  const compressionMarkToolCalls: ReplayedCompressionMarkToolCall[] = [];
  let nextSequence = 1;

  for (const envelope of envelopes) {
    if (isCanonicalHostMessageRole(envelope.info.role)) {
      hostHistory.push(
        Object.freeze({
          sequence: nextSequence++,
          message: {
            info: envelope.info as any,
            parts: envelope.parts.flatMap((part): CanonicalHostMessagePart[] => {
              if (part.type === "text") {
                return [{
                  messageId: part.messageID,
                  ...part,
                  type: "text" as const,
                }];
              }
              if (part.type === "reasoning") {
                return [{
                  messageId: part.messageID,
                  ...part,
                  type: "reasoning" as const,
                }];
              }
              if (part.type === "tool") {
                return [{
                  messageId: part.messageID,
                  ...part,
                  type: "tool" as const,
                }];
              }
              if (part.type === "file") {
                return [{
                  messageId: part.messageID,
                  ...part,
                  type: "file" as const,
                }];
              }
              return [{
                messageId: part.messageID,
                ...part,
              }];
            }),
          } satisfies CanonicalHostMessage,
        } satisfies ReplayableHostHistoryEntry),
      );
    }

    let compressionMarkOrdinal = 0;
    for (const part of envelope.parts) {
      if (!isCompressionMarkToolPart(part)) {
        continue;
      }

      const completedState = part.state.status === "completed" ? part.state : null;
      if (!completedState) {
        continue;
      }

      compressionMarkOrdinal += 1;
      const syntheticMessageId = buildCompressionMarkToolMessageId(
        envelope.info.id,
        part,
        compressionMarkOrdinal,
      );
      const syntheticSequence = nextSequence++;

      hostHistory.push(
        Object.freeze({
          sequence: syntheticSequence,
          message: {
            info: {
              id: syntheticMessageId,
              role: "tool",
            },
            parts: [
              {
                type: "text" as const,
                text: resolveCompressionMarkToolVisibleText(completedState.output),
                messageId: syntheticMessageId,
              },
            ],
          } satisfies CanonicalHostMessage,
        } satisfies ReplayableHostHistoryEntry),
      );

      const parsedInput = validateCompressionMarkInput(completedState.input);
      if (!parsedInput.ok) {
        compressionMarkToolCalls.push(
          Object.freeze({
            sequence: syntheticSequence,
            sourceMessageId: syntheticMessageId,
            outcome: "invalid-input",
            errorCode: parsedInput.result.errorCode,
            message: parsedInput.result.message,
          } satisfies ReplayedCompressionMarkToolCall),
        );
        continue;
      }

      let parsedResult: ReturnType<typeof deserializeCompressionMarkResult>;
      try {
        parsedResult = deserializeCompressionMarkResult(completedState.output);
      } catch {
        compressionMarkToolCalls.push(
          Object.freeze({
            sequence: syntheticSequence,
            sourceMessageId: syntheticMessageId,
            outcome: "invalid-result",
            mode: parsedInput.value.mode,
            startVisibleMessageId: parsedInput.value.from,
            endVisibleMessageId: parsedInput.value.to,
            errorCode: "COMPACTION_FAILED",
            message: "compression_mark returned an invalid result payload.",
          } satisfies ReplayedCompressionMarkToolCall),
        );
        continue;
      }

       compressionMarkToolCalls.push(
        Object.freeze({
          sequence: syntheticSequence,
          sourceMessageId: syntheticMessageId,
          outcome: parsedResult.ok === true ? "accepted" : "rejected",
          mode: parsedInput.value.mode,
          startVisibleMessageId: parsedInput.value.from,
          endVisibleMessageId: parsedInput.value.to,
          ...(parsedResult.ok === true
            ? {}
            : { errorCode: parsedResult.errorCode, message: parsedResult.message }),
        } satisfies ReplayedCompressionMarkToolCall),
      );

      if (parsedResult.ok !== true) {
        continue;
      }

      toolHistory.push(
        Object.freeze({
          sequence: syntheticSequence,
          sourceMessageId: syntheticMessageId,
          toolName: "compression_mark",
          input: parsedInput.value,
          result: parsedResult,
        } satisfies ReplayableCompressionMarkToolEntry),
      );
    }
  }

  return Object.freeze({
    hostHistory: Object.freeze(hostHistory),
    toolHistory: Object.freeze(toolHistory),
    compressionMarkToolCalls: Object.freeze(compressionMarkToolCalls),
  });
}

function isCanonicalHostMessageRole(
  role: unknown,
): role is CanonicalHostMessage["info"]["role"] {
  if (typeof role !== "string") {
    return false;
  }

  return (
    role === "system" ||
    role === "user" ||
    role === "assistant" ||
    role === "tool"
  );
}

function isCompressionMarkToolPart(part: Part): part is ToolPart {
  return part.type === "tool" && part.tool === "compression_mark";
}

function buildCompressionMarkToolMessageId(
  hostMessageId: string,
  part: ToolPart,
  ordinal: number,
): string {
  const callIdentity =
    typeof part.callID === "string" && part.callID.trim().length > 0
      ? part.callID.trim()
      : `${part.tool}:${ordinal}`;
  return `${hostMessageId}#compression_mark#${callIdentity}`;
}

function resolveCompressionMarkToolVisibleText(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return "compression_mark returned an empty result payload.";
  }

  try {
    const parsed = deserializeCompressionMarkResult(output);
    return parsed.ok ? trimmed : parsed.message;
  } catch {
    return trimmed;
  }
}
