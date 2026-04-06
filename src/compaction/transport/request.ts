import {
  CompactionTransportConfigurationError,
  assertDeleteExecutionIsPermitted,
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
  readonly canonicalMessageID: string;
  readonly contentText: string;
}

export interface BuildCompactionTransportRequestInput {
  readonly sessionID: string;
  readonly markID: string;
  readonly model: string;
  readonly executionMode: CompactionExecutionMode;
  readonly allowDelete: boolean;
  readonly promptText: string;
  readonly transcript: readonly BuildCompactionTransportTranscriptEntryInput[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export function buildCompactionTransportRequest(
  input: BuildCompactionTransportRequestInput,
): CompactionTransportRequest {
  const sessionID = ensureNonEmptyString(input.sessionID, "sessionID");
  const markID = ensureNonEmptyString(input.markID, "markID");
  const model = ensureNonEmptyString(input.model, "model");
  const promptText = ensureNonEmptyString(input.promptText, "promptText");
  const timeoutMs = ensurePositiveInteger(input.timeoutMs, "timeoutMs");

  assertDeleteExecutionIsPermitted({
    executionMode: input.executionMode,
    allowDelete: input.allowDelete,
  });

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
        canonicalMessageID: ensureNonEmptyString(
          entry.canonicalMessageID,
          `transcript[${index}].canonicalMessageID`,
        ),
        contentText: ensureNonEmptyString(
          entry.contentText,
          `transcript[${index}].contentText`,
        ),
      }) satisfies CompactionTransportTranscriptEntry,
    ),
  );

  return Object.freeze({
    sessionID,
    markID,
    model,
    executionMode: input.executionMode,
    allowDelete: input.allowDelete,
    promptText,
    transcript,
    timeoutMs,
    signal: input.signal,
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
