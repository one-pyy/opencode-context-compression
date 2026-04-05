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
  readonly seenRequiredPlaceholders: readonly string[];
}

export class InvalidCompactionOutputError extends Error {
  readonly issues: readonly string[];
  readonly missingPlaceholders: readonly string[];

  constructor(
    message: string,
    issues: readonly string[],
    missingPlaceholders: readonly string[] = [],
  ) {
    super(message);
    this.name = "InvalidCompactionOutputError";
    this.issues = Object.freeze([...issues]);
    this.missingPlaceholders = Object.freeze([...missingPlaceholders]);
  }
}

export function validateCompactionOutput(options: {
  readonly allowDelete: boolean;
  readonly executionMode: CompactionExecutionMode;
  readonly candidate: RawCompactionOutput;
  readonly requiredPlaceholders?: readonly string[];
}): ValidatedCompactionOutput {
  const issues: string[] = [];
  const hasText =
    typeof options.candidate.contentText === "string" &&
    options.candidate.contentText.trim().length > 0;
  const hasJSON = options.candidate.contentJSON !== undefined;
  const normalizedText = hasText ? options.candidate.contentText?.trim() : undefined;
  const serializedJSON =
    options.candidate.contentJSON === undefined
      ? undefined
      : stableStringify(options.candidate.contentJSON);
  const searchableOutput = [normalizedText, serializedJSON]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  const requiredPlaceholders = normalizeRequiredPlaceholders(
    options.requiredPlaceholders,
  );
  const seenRequiredPlaceholders = requiredPlaceholders.filter((placeholder) =>
    searchableOutput.includes(placeholder),
  );
  const missingPlaceholders = requiredPlaceholders.filter(
    (placeholder) => !seenRequiredPlaceholders.includes(placeholder),
  );

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

  if (missingPlaceholders.length > 0) {
    issues.push(
      `Compaction output is missing required placeholders: ${missingPlaceholders.join(", ")}.`,
    );
  }

  if (issues.length > 0) {
    throw new InvalidCompactionOutputError(
      `Invalid ${options.executionMode} compaction output: ${issues.join(" ")}`,
      issues,
      missingPlaceholders,
    );
  }

  return {
    contentText: normalizedText,
    contentJSON: options.candidate.contentJSON,
    metadata: options.candidate.metadata,
    seenRequiredPlaceholders,
  };
}

function normalizeRequiredPlaceholders(
  requiredPlaceholders: readonly string[] | undefined,
): readonly string[] {
  if (requiredPlaceholders === undefined || requiredPlaceholders.length === 0) {
    return [];
  }

  const normalized = requiredPlaceholders
    .map((placeholder) => placeholder.trim())
    .filter((placeholder) => placeholder.length > 0);

  return [...new Set(normalized)].sort();
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}
