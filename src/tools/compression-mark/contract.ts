import type { ToolContext } from "@opencode-ai/plugin/tool";

export const COMPRESSION_MARK_TOOL_NAME = "compression_mark";

export type CompressionMarkMode = "compact" | "delete";
export type CompressionMarkErrorCode =
  | "INVALID_RANGE"
  | "DELETE_NOT_ALLOWED"
  | "OVERLAP_CONFLICT"
  | "SESSION_NOT_READY";

export interface CompressionMarkInputV1 {
  readonly mode: CompressionMarkMode;
  readonly from: string;
  readonly to: string;
  readonly hint?: string;
}

export interface CompressionMarkSuccess {
  readonly ok: true;
  readonly markId: string;
}

export interface CompressionMarkFailure {
  readonly ok: false;
  readonly errorCode: CompressionMarkErrorCode;
  readonly message: string;
}

export type CompressionMarkResult =
  | CompressionMarkSuccess
  | CompressionMarkFailure;

export interface CompressionMarkToolInvocationContext {
  readonly sessionID: string;
  readonly messageID: string;
  readonly agent: string;
  readonly directory: string;
  readonly worktree: string;
  readonly abort: AbortSignal;
}

export type CompressionMarkValidationResult =
  | {
      readonly ok: true;
      readonly value: CompressionMarkInputV1;
    }
  | {
      readonly ok: false;
      readonly result: CompressionMarkFailure;
    };

export interface CompressionMarkExternalContract {
  readonly toolName: "compression_mark";
  readonly inputShape: "{ mode, from, to, hint? }";
  readonly outputShape: "JSON-serialized CompressionMarkResult";
  readonly callTiming: "when the model invokes the DCP tool during a chat turn";
  readonly visibleSideEffects: readonly [
    "returns a markId or DESIGN-aligned admission failure",
    "writes a replayable tool result into host history and does not persist mark truth in SQLite"
  ];
  readonly errorSemantics: readonly [
    "INVALID_RANGE for malformed or unresolvable single-range input",
    "DELETE_NOT_ALLOWED OVERLAP_CONFLICT and SESSION_NOT_READY for admission failures"
  ];
  readonly relationToRuntime: {
    readonly replay: "tool result becomes replayable mark intent input for later history replay";
    readonly resultGroups: "markId is the lookup key for future committed result-groups";
    readonly scheduler: "tool never schedules compaction directly; scheduler reacts later";
  };
}

export const COMPRESSION_MARK_EXTERNAL_CONTRACT = Object.freeze({
  toolName: "compression_mark",
  inputShape: "{ mode, from, to, hint? }",
  outputShape: "JSON-serialized CompressionMarkResult",
  callTiming: "when the model invokes the DCP tool during a chat turn",
  visibleSideEffects: [
    "returns a markId or DESIGN-aligned admission failure",
    "writes a replayable tool result into host history and does not persist mark truth in SQLite",
  ],
  errorSemantics: [
    "INVALID_RANGE for malformed or unresolvable single-range input",
    "DELETE_NOT_ALLOWED OVERLAP_CONFLICT and SESSION_NOT_READY for admission failures",
  ],
  relationToRuntime: {
    replay:
      "tool result becomes replayable mark intent input for later history replay",
    resultGroups: "markId is the lookup key for future committed result-groups",
    scheduler: "tool never schedules compaction directly; scheduler reacts later",
  },
} satisfies CompressionMarkExternalContract);

export function validateCompressionMarkInput(
  input: unknown,
): CompressionMarkValidationResult {
  const record = asRecord(input);
  if (record === undefined) {
    return invalidRange(
      'compression_mark input must be a JSON object. Example: {"mode":"compact","from":"msg_abc","to":"msg_xyz"}',
    );
  }

  if (record.mode !== "compact" && record.mode !== "delete") {
    return invalidRange(
      `compression_mark mode must be "compact" (recommended) or "delete". You provided: ${JSON.stringify(record.mode)}`,
    );
  }

  const from = readNonEmptyString(record.from);
  const to = readNonEmptyString(record.to);
  if (from === undefined || to === undefined) {
    return invalidRange(
      `compression_mark from and to must both be non-empty strings (format: msg_...). You provided: from=${JSON.stringify(record.from)}, to=${JSON.stringify(record.to)}`,
    );
  }

  const hint = record.hint !== undefined ? readNonEmptyString(record.hint) : undefined;

  return {
    ok: true,
    value: {
      mode: record.mode,
      from,
      to,
      ...(hint !== undefined ? { hint } : {}),
    },
  };
}

export function createCompressionMarkFailure(
  errorCode: CompressionMarkErrorCode,
  message: string,
): CompressionMarkFailure {
  return {
    ok: false,
    errorCode,
    message,
  };
}

export function serializeCompressionMarkResult(
  result: CompressionMarkResult,
): string {
  return JSON.stringify(result);
}

export function deserializeCompressionMarkResult(
  serialized: string,
): CompressionMarkResult {
  const parsed = JSON.parse(serialized) as unknown;
  const record = asRecord(parsed);
  if (record?.ok === true && typeof record.markId === "string") {
    return {
      ok: true,
      markId: record.markId,
    };
  }

  if (
    record?.ok === false &&
    typeof record.errorCode === "string" &&
    typeof record.message === "string"
  ) {
    return {
      ok: false,
      errorCode: record.errorCode as CompressionMarkErrorCode,
      message: record.message,
    };
  }

  throw new Error("Invalid serialized compression_mark result payload.");
}

export function toCompressionMarkToolInvocationContext(
  context: ToolContext,
): CompressionMarkToolInvocationContext {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory: context.directory,
    worktree: context.worktree,
    abort: context.abort,
  };
}

function invalidRange(message: string): CompressionMarkValidationResult {
  return {
    ok: false,
    result: createCompressionMarkFailure("INVALID_RANGE", message),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
