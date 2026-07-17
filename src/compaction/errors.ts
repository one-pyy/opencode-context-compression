export class InvalidCompactionOutputError extends Error {
  readonly markId: string;
  readonly model: string;
  readonly executionMode: "compact" | "delete";

  constructor(options: {
    readonly markId: string;
    readonly model: string;
    readonly executionMode: "compact" | "delete";
    readonly detail: string;
  }) {
    super(
      `Invalid compaction output for mark '${options.markId}' on model '${options.model}' (${options.executionMode}): ${options.detail}`,
    );
    this.name = "InvalidCompactionOutputError";
    this.markId = options.markId;
    this.model = options.model;
    this.executionMode = options.executionMode;
  }
}

export interface CompactionModelChainExhaustionInfo {
  readonly attempts: number;
}

const modelChainExhaustionInfo = new WeakMap<Error, CompactionModelChainExhaustionInfo>();

export function markCompactionModelChainExhausted(
  error: unknown,
  info: CompactionModelChainExhaustionInfo,
): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  modelChainExhaustionInfo.set(normalized, Object.freeze({ ...info }));
  return normalized;
}

export function getCompactionModelChainExhaustionInfo(
  error: unknown,
): CompactionModelChainExhaustionInfo | null {
  return error instanceof Error
    ? modelChainExhaustionInfo.get(error) ?? null
    : null;
}
