import type {
  CompactionExecutionMode,
  CompactionTransportRequest,
  CompactionTransportTranscriptRole,
} from "./transport/types.js";

export interface CompactionOpaquePlaceholder {
  readonly slot: string;
}

export interface CompactionBuildTranscriptEntry {
  readonly role: CompactionTransportTranscriptRole;
  readonly hostMessageId: string;
  readonly sourceStartSeq?: number;
  readonly sourceEndSeq?: number;
  readonly opaquePlaceholder?: CompactionOpaquePlaceholder;
  readonly contentText: string;
}

export interface CompactionBuildInput {
  readonly sessionId: string;
  readonly markId: string;
  readonly model: string;
  readonly executionMode: CompactionExecutionMode;
  readonly promptText: string;
  readonly transcript: readonly CompactionBuildTranscriptEntry[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export type CompactionRequest = CompactionTransportRequest;

export interface TransportResponse {
  readonly rawPayload: unknown;
}

export interface CompactionValidationInput {
  readonly request: CompactionRequest;
  readonly response: TransportResponse;
}

export interface ValidatedCompactionOutput {
  readonly contentText: string;
}

export interface RunCompactionInput {
  readonly build: CompactionBuildInput;
  readonly compactionModels?: readonly string[];
  readonly maxAttemptsPerModel?: number;
  readonly resultGroup?: {
    readonly sourceStartSeq?: number;
    readonly sourceEndSeq?: number;
    readonly createdAt?: string;
    readonly committedAt?: string;
  };
}

export interface RunCompactionResult {
  readonly request: CompactionRequest;
  readonly response: TransportResponse;
  readonly validatedOutput: ValidatedCompactionOutput;
}
