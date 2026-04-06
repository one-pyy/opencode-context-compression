import type {
  CompactionExecutionMode,
  CompactionTransportRequest,
} from "./types.js";

type CompactionTransportRequestSummary = Pick<
  CompactionTransportRequest,
  "sessionID" | "markID" | "model" | "executionMode"
>;

export class CompactionTransportConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionTransportConfigurationError";
  }
}

export class CompactionTransportTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Compaction transport timed out after ${timeoutMs}ms before producing a payload.`,
    );
    this.name = "CompactionTransportTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class CompactionTransportRetryableError extends Error {
  readonly code?: string;
  readonly retryable = true;

  constructor(message: string, options: { readonly code?: string } = {}) {
    super(message);
    this.name = "CompactionTransportRetryableError";
    this.code = options.code;
  }
}

export class CompactionTransportFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionTransportFatalError";
  }
}

export class CompactionTransportAbortedError extends Error {
  readonly origin: "caller" | "transport";
  readonly reason?: string;

  constructor(options: {
    readonly origin: "caller" | "transport";
    readonly reason?: string;
  }) {
    const reasonSuffix = options.reason ? ` Reason: ${options.reason}` : "";
    super(
      `Compaction transport was ${options.origin === "caller" ? "aborted" : "cancelled"} before a payload was produced.${reasonSuffix}`,
    );
    this.name = "CompactionTransportAbortedError";
    this.origin = options.origin;
    this.reason = options.reason;
  }
}

export class CompactionTransportMalformedPayloadError extends Error {
  readonly rawPayload: unknown;
  readonly request: CompactionTransportRequestSummary;

  constructor(
    request: CompactionTransportRequestSummary,
    rawPayload: unknown,
    detail: string,
  ) {
    super(
      `Malformed compaction transport payload for mark '${request.markID}' on model '${request.model}' (${request.executionMode}) in session '${request.sessionID}': ${detail}`,
    );
    this.name = "CompactionTransportMalformedPayloadError";
    this.request = request;
    this.rawPayload = rawPayload;
  }
}

export class CompactionTransportScriptExhaustedError extends Error {
  constructor() {
    super(
      "Scripted compaction transport has no remaining steps. Add another scripted step for this invocation.",
    );
    this.name = "CompactionTransportScriptExhaustedError";
  }
}

export function summarizeCompactionTransportRequest(
  request: CompactionTransportRequest,
): CompactionTransportRequestSummary {
  return {
    sessionID: request.sessionID,
    markID: request.markID,
    model: request.model,
    executionMode: request.executionMode,
  } satisfies CompactionTransportRequestSummary;
}

export function assertDeleteExecutionIsPermitted(input: {
  readonly executionMode: CompactionExecutionMode;
  readonly allowDelete: boolean;
}): void {
  if (input.executionMode === "delete" && !input.allowDelete) {
    throw new CompactionTransportConfigurationError(
      "Compaction transport request cannot use executionMode='delete' when allowDelete=false.",
    );
  }
}
