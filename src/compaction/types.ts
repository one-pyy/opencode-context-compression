import type {
  CompactionExecutionMode,
  CompactionTransportRequest,
  CompactionTransportTranscriptRole,
} from "./transport/types.js";

export interface CompactionBuildTranscriptEntry {
  readonly role: CompactionTransportTranscriptRole;
  readonly hostMessageId: string;
  readonly canonicalMessageId: string;
  readonly contentText: string;
}

export interface CompactionBuildInput {
  readonly sessionId: string;
  readonly markId: string;
  readonly model: string;
  readonly executionMode: CompactionExecutionMode;
  readonly allowDelete: boolean;
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
}

export interface RunCompactionResult {
  readonly request: CompactionRequest;
  readonly response: TransportResponse;
  readonly validatedOutput: ValidatedCompactionOutput;
}
