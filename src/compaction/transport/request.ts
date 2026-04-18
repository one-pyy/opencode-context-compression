import {
  CompactionTransportConfigurationError,
} from "./errors.js";
import type {
  CompactionExecutionMode,
  CompactionTransportRequest,
  CompactionTransportTranscriptEntry,
  CompactionTransportTranscriptRole,
} from "./types.js";

export interface BuildCompactionTransportTranscriptEntryInput {
  readonly role: CompactionTransportTranscriptRole;
  readonly hostMessageID: string;
  readonly sourceStartSeq?: number;
  readonly sourceEndSeq?: number;
  readonly opaquePlaceholderSlot?: string;
  readonly contentText: string;
}

export interface BuildCompactionTransportRequestInput {
  readonly sessionID: string;
  readonly markID: string;
  readonly model: string;
  readonly executionMode: CompactionExecutionMode;
  readonly promptText: string;
  readonly transcript: readonly BuildCompactionTransportTranscriptEntryInput[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly hint?: string;
}

export function buildCompactionTransportRequest(
  input: BuildCompactionTransportRequestInput,
): CompactionTransportRequest {
  const sessionID = ensureNonEmptyString(input.sessionID, "sessionID");
  const markID = ensureNonEmptyString(input.markID, "markID");
  const model = ensureNonEmptyString(input.model, "model");
  const promptText = ensureNonEmptyString(input.promptText, "promptText");
  const timeoutMs = ensurePositiveInteger(input.timeoutMs, "timeoutMs");

  if (input.transcript.length === 0) {
    throw new CompactionTransportConfigurationError(
      "Compaction transport request must include at least one transcript entry.",
    );
  }

  const transcript = Object.freeze(
    input.transcript.map((entry, index) =>
      Object.freeze({
        sequenceNumber: index + 1,
        role: entry.role,
        hostMessageID: ensureNonEmptyString(
          entry.hostMessageID,
          `transcript[${index}].hostMessageID`,
        ),
        sourceStartSeq: ensurePositiveInteger(
          entry.sourceStartSeq ?? index + 1,
          `transcript[${index}].sourceStartSeq`,
        ),
        sourceEndSeq: ensurePositiveInteger(
          entry.sourceEndSeq ?? entry.sourceStartSeq ?? index + 1,
          `transcript[${index}].sourceEndSeq`,
        ),
        opaquePlaceholderSlot:
          entry.opaquePlaceholderSlot === undefined
            ? undefined
            : ensureNonEmptyString(
                entry.opaquePlaceholderSlot,
                `transcript[${index}].opaquePlaceholderSlot`,
              ),
        contentText: ensureNonEmptyString(
          entry.contentText,
          `transcript[${index}].contentText`,
        ),
      }) satisfies CompactionTransportTranscriptEntry,
    ),
  );

  transcript.forEach((entry, index) => {
    if (entry.sourceEndSeq < entry.sourceStartSeq) {
      throw new CompactionTransportConfigurationError(
        `Compaction transport field 'transcript[${index}].sourceEndSeq' must be greater than or equal to sourceStartSeq.`,
      );
    }
  });

  return Object.freeze({
    sessionID,
    markID,
    model,
    executionMode: input.executionMode,
    promptText,
    transcript,
    timeoutMs,
    signal: input.signal,
    hint: input.hint,
  } satisfies CompactionTransportRequest);
}

function ensureNonEmptyString(value: string, fieldPath: string): string {
  if (typeof value !== "string") {
    throw new CompactionTransportConfigurationError(
      `Compaction transport field '${fieldPath}' must be a string.`,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CompactionTransportConfigurationError(
      `Compaction transport field '${fieldPath}' must not be empty.`,
    );
  }

  return value;
}

function ensurePositiveInteger(value: number, fieldPath: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CompactionTransportConfigurationError(
      `Compaction transport field '${fieldPath}' must be a positive integer.`,
    );
  }

  return value;
}
