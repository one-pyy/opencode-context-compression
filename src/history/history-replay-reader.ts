import { defineInternalModuleContract } from "../internal/module-contract.js";

export type CanonicalHostMessageRole = "system" | "user" | "assistant" | "tool";

export interface CanonicalHostMessagePart {
  readonly type: "text";
  readonly text: string;
  readonly messageId?: string;
}

export interface CanonicalHostMessage {
  readonly info: {
    readonly id: string;
    readonly role: CanonicalHostMessageRole;
  };
  readonly parts: readonly CanonicalHostMessagePart[];
}

export interface ReplayedHistoryMessage {
  readonly sequence: number;
  readonly canonicalId: string;
  readonly role: CanonicalHostMessageRole;
  readonly contentText: string;
  readonly hostMessage: CanonicalHostMessage;
}

export interface ReplayedMarkIntent {
  readonly markId: string;
  readonly mode: "compact" | "delete";
  readonly startVisibleMessageId: string;
  readonly endVisibleMessageId: string;
  readonly sourceMessageId: string;
}

export interface ReplayedHistory {
  readonly sessionId: string;
  readonly messages: readonly ReplayedHistoryMessage[];
  readonly marks: readonly ReplayedMarkIntent[];
}

export interface HistoryReplayReader {
  read(sessionId: string): Promise<ReplayedHistory>;
}

export const HISTORY_REPLAY_READER_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "HistoryReplayReader",
    inputs: ["sessionId"],
    outputs: ["ReplayedHistory"],
    mutability: "read-only",
    reads: ["canonical host history", "replayable compression_mark tool results"],
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
