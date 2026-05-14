import type { ToolContext } from "@opencode-ai/plugin/tool";

export const COMPRESSION_INSPECT_TOOL_NAME = "compression_inspect";

export type CompressionInspectErrorCode = "INVALID_RANGE" | "SESSION_NOT_READY";

export interface CompressionInspectInputV1 {
  readonly from: string;
  readonly to: string;
}

export interface CompressionInspectPlaceholder {
  readonly ok: true;
  readonly inspectId: string;
}

export interface CompressionInspectMessageTokenInfo {
  readonly id: string;
  readonly tokens: number;
}

export interface CompressionInspectResolved {
  readonly ok: true;
  readonly messages: readonly CompressionInspectMessageTokenInfo[];
}

export interface CompressionInspectFailure {
  readonly ok: false;
  readonly errorCode: CompressionInspectErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type CompressionInspectResult =
  | CompressionInspectPlaceholder
  | CompressionInspectResolved
  | CompressionInspectFailure;

export interface CompressionInspectToolInvocationContext {
  readonly sessionID: string;
  readonly messageID: string;
  readonly agent: string;
  readonly directory: string;
  readonly worktree: string;
  readonly abort: AbortSignal;
}

export type CompressionInspectValidationResult =
  | {
      readonly ok: true;
      readonly value: CompressionInspectInputV1;
    }
  | {
      readonly ok: false;
      readonly result: CompressionInspectFailure;
    };

export interface CompressionInspectExternalContract {
  readonly toolName: "compression_inspect";
  readonly inputShape: "{ from, to }";
  readonly outputShape: "placeholder first, then JSON-serialized resolved message token array after projection";
  readonly callTiming: "when the model needs to inspect uncompressed compressible messages in a visible-id range";
  readonly visibleSideEffects: readonly [
    "returns an inspectId placeholder immediately",
    "messages.transform replaces the placeholder with message ids and token counts from the current projection state"
  ];
  readonly relationToRuntime: {
    readonly replay: "tool result becomes a replayable inspect request for later projection";
    readonly tokenCounts: "uses ProjectionState.messagePolicies from messages.transform and never recalculates tokens in the tool";
    readonly scheduler: "tool never schedules compaction directly";
  };
}

export const COMPRESSION_INSPECT_EXTERNAL_CONTRACT = Object.freeze({
  toolName: "compression_inspect",
  inputShape: "{ from, to }",
  outputShape:
    "placeholder first, then JSON-serialized resolved message token array after projection",
  callTiming:
    "when the model needs to inspect uncompressed compressible messages in a visible-id range",
  visibleSideEffects: [
    "returns an inspectId placeholder immediately",
    "messages.transform replaces the placeholder with message ids and token counts from the current projection state",
  ],
  relationToRuntime: {
    replay: "tool result becomes a replayable inspect request for later projection",
    tokenCounts:
      "uses ProjectionState.messagePolicies from messages.transform and never recalculates tokens in the tool",
    scheduler: "tool never schedules compaction directly",
  },
} satisfies CompressionInspectExternalContract);

export function validateCompressionInspectInput(
  input: unknown,
): CompressionInspectValidationResult {
  const record = asRecord(input);
  if (record === undefined) {
    return invalidRange(
      'compression_inspect input must be a JSON object. Example: {"from":"compressible_000123_ab","to":"compressible_000130_q7"}',
    );
  }

  const from = readNonEmptyString(record.from);
  const to = readNonEmptyString(record.to);
  if (from === undefined || to === undefined) {
    return invalidRange(
      `compression_inspect from and to must both be non-empty visible message IDs. You provided: from=${JSON.stringify(record.from)}, to=${JSON.stringify(record.to)}`,
    );
  }

  return {
    ok: true,
    value: { from, to },
  };
}

export function createCompressionInspectFailure(
  errorCode: CompressionInspectErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): CompressionInspectFailure {
  return {
    ok: false,
    errorCode,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

export function serializeCompressionInspectResult(
  result: CompressionInspectResult,
): string {
  return JSON.stringify(result);
}

export function deserializeCompressionInspectResult(
  serialized: string,
): CompressionInspectResult {
  const parsed = JSON.parse(serialized) as unknown;
  const record = asRecord(parsed);
  if (record?.ok === true && typeof record.inspectId === "string") {
    return {
      ok: true,
      inspectId: record.inspectId,
    };
  }

  if (record?.ok === true && Array.isArray(record.messages)) {
    return {
      ok: true,
      messages: Object.freeze(
        record.messages.map((message) => {
          const item = asRecord(message);
          if (typeof item?.id !== "string" || typeof item.tokens !== "number") {
            throw new Error("Invalid serialized compression_inspect message payload.");
          }
          return Object.freeze({ id: item.id, tokens: item.tokens });
        }),
      ),
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
      errorCode: record.errorCode as CompressionInspectErrorCode,
      message: record.message,
      ...(details === undefined ? {} : { details }),
    };
  }

  throw new Error("Invalid serialized compression_inspect result payload.");
}

export function toCompressionInspectToolInvocationContext(
  context: ToolContext,
): CompressionInspectToolInvocationContext {
  return {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory: context.directory,
    worktree: context.worktree,
    abort: context.abort,
  };
}

function invalidRange(message: string): CompressionInspectValidationResult {
  return {
    ok: false,
    result: createCompressionInspectFailure("INVALID_RANGE", message),
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
