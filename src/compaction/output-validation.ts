import type { CompactionExecutionMode, JsonValue } from "../state/store.js";

export interface RawCompactionOutput {
  readonly contentText?: string;
  readonly contentJSON?: JsonValue;
  readonly metadata?: JsonValue;
}

export interface ValidatedCompactionOutput {
  readonly contentText?: string;
  readonly contentJSON?: JsonValue;
  readonly metadata?: JsonValue;
}

export class InvalidCompactionOutputError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super(message);
    this.name = "InvalidCompactionOutputError";
    this.issues = Object.freeze([...issues]);
  }
}

export function validateCompactionOutput(options: {
  readonly allowDelete: boolean;
  readonly executionMode: CompactionExecutionMode;
  readonly candidate: RawCompactionOutput;
}): ValidatedCompactionOutput {
  const issues: string[] = [];
  const hasText =
    typeof options.candidate.contentText === "string" &&
    options.candidate.contentText.trim().length > 0;
  const hasJSON = options.candidate.contentJSON !== undefined;

  if (!hasText && !hasJSON) {
    issues.push(
      options.executionMode === "delete"
        ? "Delete compaction output must include a non-empty delete notice or structured payload."
        : "Compaction output must include a non-empty replacement text or structured payload.",
    );
  }

  if (options.executionMode === "delete" && !options.allowDelete) {
    issues.push(
      "Delete compaction output is invalid when allowDelete is false.",
    );
  }

  if (issues.length > 0) {
    throw new InvalidCompactionOutputError(
      `Invalid ${options.executionMode} compaction output: ${issues.join(" ")}`,
      issues,
    );
  }

  return {
    contentText: hasText ? options.candidate.contentText : undefined,
    contentJSON: options.candidate.contentJSON,
    metadata: options.candidate.metadata,
  };
}
