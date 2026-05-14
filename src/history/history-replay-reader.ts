import { defineInternalModuleContract } from "../internal/module-contract.js";
import type {
  CompressionMarkInputV1,
  CompressionMarkResult,
} from "../tools/compression-mark/contract.js";
import type {
  CompressionInspectInputV1,
  CompressionInspectResult,
} from "../tools/compression-inspect/contract.js";

export type CanonicalHostMessageRole = "system" | "user" | "assistant" | "tool";

export type CanonicalHostMessagePart = 
  | { readonly type: "text"; readonly text: string; readonly messageId?: string; [key: string]: unknown; }
  | { readonly type: "reasoning"; readonly text: string; readonly messageId?: string; [key: string]: unknown; }
  | { readonly type: "tool"; readonly tool: string; readonly callID: string; readonly state: unknown; readonly messageId?: string; [key: string]: unknown; }
  | { readonly type: "file"; readonly mime: string; readonly filename?: string; readonly url: string; readonly messageId?: string; [key: string]: unknown; }
  | { readonly type: string; readonly messageId?: string; [key: string]: unknown; };

export interface CanonicalHostMessage {
  readonly info: {
    readonly id: string;
    readonly role: CanonicalHostMessageRole;
    [key: string]: unknown;
  };
  readonly parts: readonly CanonicalHostMessagePart[];
}

export interface ReplayedHistoryMessage {
  readonly sequence: number;
  readonly canonicalId: string;
  readonly role: CanonicalHostMessageRole;
  readonly contentText: string;
  readonly parts: readonly CanonicalHostMessagePart[];
  readonly hostMessage: CanonicalHostMessage;
}

export interface ReplayedMarkIntent {
  readonly markId: string;
  readonly mode: "compact" | "delete";
  readonly startVisibleMessageId: string;
  readonly endVisibleMessageId: string;
  readonly sourceMessageId: string;
  readonly sourceSequence: number;
  readonly hint?: string;
}

export interface ReplayedCompressionMarkToolCall {
  readonly sequence: number;
  readonly sourceMessageId: string;
  readonly outcome:
    | "accepted"
    | "rejected"
    | "invalid-input"
    | "invalid-result";
  readonly mode?: "compact" | "delete";
  readonly startVisibleMessageId?: string;
  readonly endVisibleMessageId?: string;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface ReplayedHistory {
  readonly sessionId: string;
  readonly messages: readonly ReplayedHistoryMessage[];
  readonly marks: readonly ReplayedMarkIntent[];
  readonly compressionMarkToolCalls: readonly ReplayedCompressionMarkToolCall[];
  readonly compressionInspectToolCalls?: readonly ReplayedCompressionInspectToolCall[];
}

const LEADING_VISIBLE_ID_PREFIX_PATTERN =
  /^\[(?:protected|compressible|referable)_\d{6}_[0-9A-Za-z]{2}\]\s?/u;

export interface HistoryReplayReader {
  read(sessionId: string): Promise<ReplayedHistory>;
}

export interface ReplayableHostHistoryEntry {
  readonly sequence: number;
  readonly message: CanonicalHostMessage;
}

export interface ReplayableCompressionMarkToolEntry {
  readonly sequence: number;
  readonly sourceMessageId: string;
  readonly toolName: "compression_mark";
  readonly input: CompressionMarkInputV1;
  readonly result: CompressionMarkResult;
}

export interface ReplayableCompressionInspectToolEntry {
  readonly sequence: number;
  readonly sourceMessageId: string;
  readonly toolName: "compression_inspect";
  readonly input: CompressionInspectInputV1;
  readonly result: CompressionInspectResult;
}

export interface ReplayedCompressionInspectToolCall {
  readonly sequence: number;
  readonly sourceMessageId: string;
  readonly outcome: "accepted" | "rejected" | "invalid-input" | "invalid-result";
  readonly inspectId?: string;
  readonly startVisibleMessageId?: string;
  readonly endVisibleMessageId?: string;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface ReplayHistorySources {
  readonly sessionId: string;
  readonly hostHistory: readonly ReplayableHostHistoryEntry[];
  readonly toolHistory: readonly ReplayablePluginToolEntry[];
  readonly compressionMarkToolCalls?: readonly ReplayedCompressionMarkToolCall[];
  readonly compressionInspectToolCalls?: readonly ReplayedCompressionInspectToolCall[];
}

export type ReplayablePluginToolEntry =
  | ReplayableCompressionMarkToolEntry
  | ReplayableCompressionInspectToolEntry;

export const HISTORY_REPLAY_READER_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "HistoryReplayReader",
    inputs: ["sessionId"],
    outputs: ["ReplayedHistory"],
    mutability: "read-only",
    reads: ["canonical host history", "replayable compression tool results"],
    writes: [],
    errorTypes: ["SESSION_NOT_READY"],
    idempotency:
      "Idempotent for the same session history snapshot and replay rules.",
    dependencyDirection: {
      inboundFrom: ["external-adapters", "ProjectionBuilder"],
      outboundTo: [],
    },
  });

export function createHistoryReplayReader(
  read: (sessionId: string) => Promise<ReplayedHistory> | ReplayedHistory,
): HistoryReplayReader {
  return {
    async read(sessionId) {
      return read(sessionId);
    },
  } satisfies HistoryReplayReader;
}

export function createHistoryReplayReaderFromSources(
  readSources:
    | ((sessionId: string) => Promise<ReplayHistorySources> | ReplayHistorySources)
    | ReplayHistorySources,
): HistoryReplayReader {
  return createHistoryReplayReader(async (sessionId) => {
    const sources =
      typeof readSources === "function" ? await readSources(sessionId) : readSources;
    return replayHistoryFromSources(sources);
  });
}

export function replayHistoryFromSources(
  sources: ReplayHistorySources,
): ReplayedHistory {
  const hostHistory = [...sources.hostHistory].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const toolHistory = [...sources.toolHistory].sort(
    (left, right) => left.sequence - right.sequence,
  );

  return Object.freeze({
    sessionId: sources.sessionId,
    messages: Object.freeze(
      hostHistory.map((entry) => {
        const canonicalId = entry.message.info.id.trim();
        if (canonicalId.length === 0) {
          throw new Error(
            "History replay requires every host message to expose a non-empty info.id.",
          );
        }

        return Object.freeze({
          sequence: entry.sequence,
          canonicalId,
          role: entry.message.info.role,
          contentText: readCanonicalMessageText(entry.message),
          parts: entry.message.parts,
          hostMessage: entry.message,
        } satisfies ReplayedHistoryMessage);
      }),
    ),
    marks: Object.freeze(
      toolHistory.flatMap((entry) => {
        if (entry.toolName !== "compression_mark") {
          return [];
        }
        if (entry.result.ok !== true) {
          return [];
        }

        return [
          Object.freeze({
            markId: entry.result.markId,
            mode: entry.input.mode,
            startVisibleMessageId: entry.input.from,
            endVisibleMessageId: entry.input.to,
            sourceMessageId: entry.sourceMessageId,
            sourceSequence: entry.sequence,
            hint: entry.input.hint,
          } satisfies ReplayedMarkIntent),
        ];
      }),
    ),
    compressionMarkToolCalls: Object.freeze(
      sources.compressionMarkToolCalls ??
        toolHistory.filter(isReplayableCompressionMarkToolEntry).map((entry) =>
          Object.freeze({
            sequence: entry.sequence,
            sourceMessageId: entry.sourceMessageId,
            outcome: entry.result.ok === true ? "accepted" : "rejected",
            mode: entry.input.mode,
            startVisibleMessageId: entry.input.from,
            endVisibleMessageId: entry.input.to,
            ...(entry.result.ok === true
              ? {}
              : { errorCode: entry.result.errorCode, message: entry.result.message }),
          } satisfies ReplayedCompressionMarkToolCall),
        ),
    ),
    compressionInspectToolCalls: Object.freeze(
      sources.compressionInspectToolCalls ??
        toolHistory.filter(isReplayableCompressionInspectToolEntry).map((entry) => {
          const outcome = entry.result.ok === true ? "accepted" : "rejected";
          return Object.freeze({
            sequence: entry.sequence,
            sourceMessageId: entry.sourceMessageId,
            outcome,
            startVisibleMessageId: entry.input.from,
            endVisibleMessageId: entry.input.to,
            ...(entry.result.ok === true && "inspectId" in entry.result
              ? { inspectId: entry.result.inspectId }
              : {}),
            ...(entry.result.ok === false
              ? { errorCode: entry.result.errorCode, message: entry.result.message }
              : {}),
          } satisfies ReplayedCompressionInspectToolCall);
        }),
    ),
  } satisfies ReplayedHistory);
}

function isReplayableCompressionMarkToolEntry(
  entry: ReplayablePluginToolEntry,
): entry is ReplayableCompressionMarkToolEntry {
  return entry.toolName === "compression_mark";
}

function isReplayableCompressionInspectToolEntry(
  entry: ReplayablePluginToolEntry,
): entry is ReplayableCompressionInspectToolEntry {
  return entry.toolName === "compression_inspect";
}

function readCanonicalMessageText(message: CanonicalHostMessage): string {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") {
        return [part.text];
      }
      return [];
    })
    .join("\n")
    .replace(LEADING_VISIBLE_ID_PREFIX_PATTERN, "")
    .trim();
}
