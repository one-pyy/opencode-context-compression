import type { ToolContext } from "@opencode-ai/plugin/tool";

export const COMPRESSION_RECALL_TOOL_NAME = "compression_recall";

export type CompressionRecallErrorCode =
  | "INVALID_RANGE"
  | "TARGET_NOT_FOUND"
  | "RANGE_RETIRED"
  | "SESSION_NOT_READY";

export interface CompressionRecallInputV1 {
  readonly from: string;
  readonly to: string;
}

export interface CompressionRecallPlaceholder {
  readonly ok: true;
  readonly recallId: string;
}

export interface CompressionRecallFailure {
  readonly ok: false;
  readonly errorCode: CompressionRecallErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CompressionRecallResolved {
  readonly ok: true;
  readonly transcript: string;
}

export type CompressionRecallResult =
  | CompressionRecallPlaceholder
  | CompressionRecallResolved
  | CompressionRecallFailure;

export interface CompressionRecallToolInvocationContext {
  readonly sessionID: string;
  readonly messageID: string;
  readonly agent: string;
  readonly directory: string;
  readonly worktree: string;
  readonly abort: AbortSignal;
}

export type CompressionRecallValidationResult =
  | {
      readonly ok: true;
      readonly value: CompressionRecallInputV1;
    }
  | {
      readonly ok: false;
      readonly result: CompressionRecallFailure;
    };

export interface CompressionRecallExternalContract {
  readonly toolName: "compression_recall";
  readonly inputShape: "{ from, to }";
  readonly outputShape: "placeholder first, then JSON-serialized original transcript after projection";
  readonly callTiming: "when the model needs to recall original host history content behind a visible-id range";
  readonly visibleSideEffects: readonly [
    "returns a recallId placeholder immediately",
    "messages.transform replaces the placeholder with original host history transcript from the requested sequence range"
  ];
  readonly relationToRuntime: {
    readonly replay: "tool result becomes a replayable recall request for later projection";
    readonly history: "checks effective delete coverage before rendering original ReplayedHistory.messages";
    readonly scheduler: "tool never schedules compaction directly";
  };
}

export const COMPRESSION_RECALL_EXTERNAL_CONTRACT = Object.freeze({
  toolName: "compression_recall",
  inputShape: "{ from, to }",
  outputShape:
    "placeholder first, then JSON-serialized original transcript after projection",
  callTiming:
    "when the model needs to recall original host history content behind a visible-id range",
  visibleSideEffects: [
    "returns a recallId placeholder immediately",
    "messages.transform replaces the placeholder with original host history transcript from the requested sequence range",
  ],
  relationToRuntime: {
    replay:
      "tool result becomes a replayable recall request for later projection",
    history:
      "checks effective delete coverage before rendering original ReplayedHistory.messages",
    scheduler: "tool never schedules compaction directly",
  },
} satisfies CompressionRecallExternalContract);

export function validateCompressionRecallInput(
  input: unknown,
): CompressionRecallValidationResult {
  const record = asRecord(input);
  if (record === undefined) {
    return invalidRange(
      'compression_recall input must be a JSON object. Example: {"from":"referable_000123_ab","to":"referable_000130_q7"}',
    );
  }

  const from = readNonEmptyString(record.from);
  const to = readNonEmptyString(record.to);
  if (from === undefined || to === undefined) {
    return invalidRange(
      `compression_recall from and to must both be non-empty visible message IDs. You provided: from=${JSON.stringify(record.from)}, to=${JSON.stringify(record.to)}`,
    );
  }

  return {
    ok: true,
    value: { from, to },
  };
}

export function createCompressionRecallFailure(
  errorCode: CompressionRecallErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): CompressionRecallFailure {
  return {
    ok: false,
    errorCode,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

export function serializeCompressionRecallResult(
  result: CompressionRecallResult,
): string {
  return JSON.stringify(result);
}

export function deserializeCompressionRecallResult(
  serialized: string,
): CompressionRecallResult {
  const parsed = JSON.parse(serialized) as unknown;
  const record = asRecord(parsed);
  if (record?.ok === true && typeof record.recallId === "string") {
    return {
      ok: true,
      recallId: record.recallId,
    };
  }

  if (record?.ok === true && typeof record.transcript === "string") {
    return {
      ok: true,
      transcript: record.transcript,
    };
  }

  if (
    record?.ok === false &&
    typeof record.errorCode === "string" &&
    typeof record.message === "string"
  ) {
    const details = asRecord(record.details);
    return {
      ok: false,
      errorCode: record.errorCode as CompressionRecallErrorCode,
      message: record.message,
      ...(details === undefined ? {} : { details }),
    };
  }

  throw new Error("Invalid serialized compression_recall result payload.");
}

export function toCompressionRecallToolInvocationContext(
  context: ToolContext,
): CompressionRecallToolInvocationContext {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory: context.directory,
    worktree: context.worktree,
    abort: context.abort,
  };
}

function invalidRange(message: string): CompressionRecallValidationResult {
  return {
    ok: false,
    result: createCompressionRecallFailure("INVALID_RANGE", message),
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
