import { parseVisibleId } from "../identity/visible-sequence.js";
import { renderModelVisiblePartsText } from "../model-visible-transcript.js";
import {
  createCompressionRecallFailure,
  serializeCompressionRecallResult,
} from "../tools/compression-recall.js";
import type { ReplayedHistoryMessage } from "../history/history-replay-reader.js";
import type { ProjectionState, ToolResultOverride } from "./types.js";

export function buildCompressionRecallOverrides(
  state: ProjectionState,
): readonly ToolResultOverride[] {
  const messagesBySequence = new Map(
    state.history.messages.map((message) => [message.sequence, message]),
  );

  return Object.freeze(
    (state.history.compressionRecallToolCalls ?? []).flatMap((call) => {
      if (
        call.outcome !== "accepted" ||
        call.startVisibleMessageId === undefined ||
        call.endVisibleMessageId === undefined
      ) {
        return [];
      }

      let output: string;
      try {
        const transcript = recallMessagesInRange({
          messagesBySequence,
          from: call.startVisibleMessageId,
          to: call.endVisibleMessageId,
        });
        if (transcript.length === 0) {
          output = serializeCompressionRecallResult(
            createCompressionRecallFailure(
              "TARGET_NOT_FOUND",
              "compression_recall found no host history messages in the requested range.",
              {
                from: call.startVisibleMessageId,
                to: call.endVisibleMessageId,
              },
            ),
          );
        } else {
          output = serializeCompressionRecallResult({
            ok: true,
            transcript,
          });
        }
      } catch (error) {
        output = serializeCompressionRecallResult(
          createCompressionRecallFailure(
            "INVALID_RANGE",
            error instanceof Error
              ? error.message
              : "compression_recall could not resolve the requested range.",
            {
              from: call.startVisibleMessageId,
              to: call.endVisibleMessageId,
            },
          ),
        );
      }

      return [
        Object.freeze({
          sourceMessageId: call.sourceMessageId,
          toolName: "compression_recall",
          output,
        } satisfies ToolResultOverride),
      ];
    }),
  );
}

export function recallMessagesInRange(input: {
  readonly messagesBySequence: ReadonlyMap<number, ReplayedHistoryMessage>;
  readonly from: string;
  readonly to: string;
}): string {
  const fromSeq = extractVisibleSeq(input.from);
  const toSeq = extractVisibleSeq(input.to);

  if (fromSeq > toSeq) {
    throw new Error("compression_recall from/to range is reversed.");
  }

  const blocks: string[] = [];
  for (let sequence = fromSeq; sequence <= toSeq; sequence += 1) {
    const message = input.messagesBySequence.get(sequence);
    if (!message) {
      continue;
    }

    const contentText = renderModelVisiblePartsText(message.parts, {
      stripLeadingVisibleIdPrefix: true,
    });

    blocks.push(
      `### ${sequence}. ${message.role} host_${sequence} (${message.canonicalId})\n${contentText}`,
    );
  }

  return blocks.join("\n\n");
}

function extractVisibleSeq(visibleId: string): number {
  const parsed = parseVisibleId(visibleId);
  return parsed.visibleSeq;
}
