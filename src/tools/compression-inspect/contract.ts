import type { ToolContext } from "@opencode-ai/plugin/tool";

export const COMPRESSION_INSPECT_TOOL_NAME = "compression_inspect";

export type CompressionInspectErrorCode = "INVALID_RANGE" | "SESSION_NOT_READY";

export interface CompressionInspectInputV1 {
  readonly to: string;
  readonly mergeAdjacent: boolean;
}

export interface CompressionInspectPlaceholder {
  readonly ok: true;
  readonly inspectId: string;
}

export interface CompressionInspectMessageTokenInfo {
  readonly id: string;
  readonly tokens: number;
}

export interface CompressionInspectAtom {
  readonly from: string;
  readonly to: string;
  readonly messageCount: number;
  readonly tokens: number;
}

export interface CompressionInspectSection {
  readonly from: string;
  readonly to: string;
  readonly totalTokens: number;
  readonly atoms: readonly CompressionInspectAtom[];
}

export type CompressionInspectResolved =
  | {
      readonly ok: true;
      readonly messages: readonly CompressionInspectMessageTokenInfo[];
    }
  | {
      readonly ok: true;
      readonly sections: readonly CompressionInspectSection[];
      readonly totalTokens: number;
    };

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
  readonly inputShape: "{ to, mergeAdjacent? }";
  readonly outputShape: "placeholder first, then JSON-serialized message details or referable sections with protected-delimited atoms after projection";
  readonly callTiming: "when the model needs to inspect uncompressed compressible messages up to a visible-id endpoint";
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
  inputShape: "{ to, mergeAdjacent? }",
  outputShape:
    "placeholder first, then JSON-serialized message details or referable sections with protected-delimited atoms after projection",
  callTiming:
    "when the model needs to inspect uncompressed compressible messages up to a visible-id endpoint",
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
      'compression_inspect input must be a JSON object. Example: {"to":"compressible_000130_q7"}',
    );
  }

  const to = readNonEmptyString(record.to);
  if (to === undefined) {
    return invalidRange(
      `compression_inspect to must be a non-empty visible message ID. You provided: to=${JSON.stringify(record.to)}`,
    );
  }

  const mergeAdjacent =
    record.mergeAdjacent === undefined ? true : readBoolean(record.mergeAdjacent);
  if (mergeAdjacent === undefined) {
    return invalidRange(
      `compression_inspect mergeAdjacent must be a boolean. You provided: mergeAdjacent=${JSON.stringify(record.mergeAdjacent)}`,
    );
  }

  return {
    ok: true,
    value: { to, mergeAdjacent },
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

  if (record?.ok === true && Array.isArray(record.sections)) {
    const totalTokens = record.totalTokens;
    if (typeof totalTokens !== "number") {
      throw new Error("Invalid serialized compression_inspect section payload.");
    }

    return {
      ok: true,
      sections: Object.freeze(
        record.sections.map((section) => {
          const item = asRecord(section);
          if (
            typeof item?.from !== "string" ||
            typeof item.to !== "string" ||
            typeof item.totalTokens !== "number" ||
            !Array.isArray(item.atoms)
          ) {
            throw new Error("Invalid serialized compression_inspect section payload.");
          }
          return Object.freeze({
            from: item.from,
            to: item.to,
            totalTokens: item.totalTokens,
            atoms: Object.freeze(
              item.atoms.map((atom) => {
                const atomItem = asRecord(atom);
                if (
                  typeof atomItem?.from !== "string" ||
                  typeof atomItem.to !== "string" ||
                  typeof atomItem.messageCount !== "number" ||
                  typeof atomItem.tokens !== "number"
                ) {
                  throw new Error("Invalid serialized compression_inspect atom payload.");
                }
                return Object.freeze({
                  from: atomItem.from,
                  to: atomItem.to,
                  messageCount: atomItem.messageCount,
                  tokens: atomItem.tokens,
                });
              }),
            ),
          });
        }),
      ),
      totalTokens,
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

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
