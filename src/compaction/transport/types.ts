export type CompactionExecutionMode = "compact" | "delete";

export type CompactionTransportTranscriptRole = "user" | "assistant" | "tool";

export interface CompactionTransportTranscriptEntry {
  readonly sequenceNumber: number;
  readonly role: CompactionTransportTranscriptRole;
  readonly hostMessageID: string;
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly opaquePlaceholderSlot?: string;
  readonly contentText: string;
}

export interface CompactionTransportRequest {
  readonly sessionID: string;
  readonly markID: string;
  readonly model: string;
  readonly executionMode: CompactionExecutionMode;
  readonly promptText: string;
  readonly transcript: readonly CompactionTransportTranscriptEntry[];
  readonly timeoutMs: number;
  readonly firstTokenTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly hint?: string;
}

export interface CompactionTransport {
  invoke(request: CompactionTransportRequest): Promise<unknown>;
}

export interface RecordedCompactionTransportRequest {
  readonly sessionID: string;
  readonly markID: string;
  readonly model: string;
  readonly executionMode: CompactionExecutionMode;
  readonly promptText: string;
  readonly transcript: readonly CompactionTransportTranscriptEntry[];
  readonly timeoutMs: number;
  readonly firstTokenTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly signalState: "missing" | "active" | "aborted";
}

export type RecordedCompactionTransportCallOutcome =
  | {
      readonly kind: "success";
      readonly rawPayload: unknown;
    }
  | {
      readonly kind: "retryable-error";
      readonly message: string;
      readonly code?: string;
    }
  | {
      readonly kind: "fatal-error";
      readonly message: string;
    }
  | {
      readonly kind: "timeout";
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "aborted";
      readonly origin: "caller" | "transport";
      readonly reason?: string;
    };

export interface RecordedCompactionTransportCall {
  readonly callIndex: number;
  readonly request: RecordedCompactionTransportRequest;
  readonly outcome: RecordedCompactionTransportCallOutcome;
}

export interface ValidatedCompactionTransportPayload {
  readonly contentText: string;
}
