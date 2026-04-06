import type { Message, Part, ToolPart } from "@opencode-ai/sdk";

import {
  createHistoryReplayReaderFromSources,
  type CanonicalHostMessage,
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
  return {
    sessionId: input.sessionId,
    hostHistory: collectReplayableHostHistory(envelopes),
    toolHistory: collectReplayableCompressionMarkHistory(envelopes),
  } satisfies ReplayHistorySources;
}

export function collectReplayableHostHistory(
  envelopes: readonly SessionMessageEnvelope[],
): readonly ReplayableHostHistoryEntry[] {
  let sequence = 1;

  return Object.freeze(
    envelopes
      .filter((envelope) => isCanonicalHostMessageRole(envelope.info.role))
      .map((envelope) =>
        Object.freeze({
          sequence: sequence++,
          message: {
            info: {
              id: envelope.info.id,
              role: envelope.info.role,
            },
            parts: envelope.parts.flatMap((part) =>
              part.type === "text"
                ? [
                    {
                      type: "text" as const,
                      text: part.text,
                      messageId: part.messageID,
                    },
                  ]
                : [],
            ),
          } satisfies CanonicalHostMessage,
        } satisfies ReplayableHostHistoryEntry),
      ),
  );
}

export function collectReplayableCompressionMarkHistory(
  envelopes: readonly SessionMessageEnvelope[],
): readonly ReplayableCompressionMarkToolEntry[] {
  const sequenceByMessageId = new Map<string, number>();
  let nextSequence = 1;

  for (const envelope of envelopes) {
    if (!isCanonicalHostMessageRole(envelope.info.role)) {
      continue;
    }

    sequenceByMessageId.set(envelope.info.id, nextSequence++);
  }

  const entries: ReplayableCompressionMarkToolEntry[] = [];
  for (const envelope of envelopes) {
    for (const part of envelope.parts) {
      if (!isCompressionMarkToolPart(part)) {
        continue;
      }

      const completedState = part.state.status === "completed" ? part.state : null;
      if (!completedState) {
        continue;
      }

      const parsedInput = validateCompressionMarkInput(completedState.input);
      if (!parsedInput.ok) {
        continue;
      }

      let parsedResult: ReturnType<typeof deserializeCompressionMarkResult>;
      try {
        parsedResult = deserializeCompressionMarkResult(completedState.output);
      } catch {
        continue;
      }

      entries.push(
        Object.freeze({
          sequence: sequenceByMessageId.get(part.messageID) ?? Number.MAX_SAFE_INTEGER,
          sourceMessageId: part.messageID,
          toolName: "compression_mark",
          input: parsedInput.value,
          result: parsedResult,
        } satisfies ReplayableCompressionMarkToolEntry),
      );
    }
  }

  return Object.freeze(entries.sort((left, right) => left.sequence - right.sequence));
}

function isCanonicalHostMessageRole(
  role: Message["role"],
): role is Extract<CanonicalHostMessage["info"]["role"], "user" | "assistant"> {
  return role === "user" || role === "assistant";
}

function isCompressionMarkToolPart(part: Part): part is ToolPart {
  return part.type === "tool" && part.tool === "compression_mark";
}
