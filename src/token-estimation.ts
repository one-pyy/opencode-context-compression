import { encoding_for_model, get_encoding, type TiktokenModel } from "tiktoken";

import type { TransformEnvelope } from "./seams/noop-observation.js";

const DEFAULT_ENCODING = "cl100k_base";
const MODEL_ENCODING_ALIASES = new Map<string, TiktokenModel>([
  ["gpt-5", "gpt-4o" as TiktokenModel],
  ["gpt-5.4-mini", "gpt-4o-mini" as TiktokenModel],
]);

type TokenEstimateSource = "tokenizer";

export class OpencodeContextCompressionTokenEstimationError extends Error {
  constructor(message: string) {
    super(`opencode-context-compression token estimation error: ${message}`);
    this.name = "OpencodeContextCompressionTokenEstimationError";
  }
}

export interface TokenEstimate {
  readonly tokenCount: number;
  readonly source: TokenEstimateSource;
}

export interface EstimateEnvelopeTokensOptions {
  readonly envelope: TransformEnvelope;
  readonly modelName?: string;
}

export function estimateEnvelopeTokens(
  options: EstimateEnvelopeTokensOptions,
): TokenEstimate {
  const content = readEnvelopeText(options.envelope);
  if (content.length === 0) {
    return {
      tokenCount: 0,
      source: "tokenizer",
    };
  }

  const tokenizerCount = estimateWithTokenizer(content, options.modelName);
  return {
    tokenCount: tokenizerCount,
    source: "tokenizer",
  };
}

function estimateWithTokenizer(
  content: string,
  modelName: string | undefined,
): number {
  try {
    const encoding = resolveEncoding(modelName);
    try {
      return encoding.encode(content).length;
    } finally {
      encoding.free();
    }
  } catch (error) {
    throw new OpencodeContextCompressionTokenEstimationError(
      `${describeModel(modelName)} could not be tokenized with tiktoken: ${describeError(error)}`,
    );
  }
}

function resolveEncoding(modelName: string | undefined) {
  if (typeof modelName === "string" && modelName.trim().length > 0) {
    try {
      return encoding_for_model(normalizeModelName(modelName));
    } catch {
      throw new OpencodeContextCompressionTokenEstimationError(
        `Unsupported tokenizer model '${modelName}'. Add a repo-owned alias before using it for threshold decisions.`,
      );
    }
  }

  return get_encoding(DEFAULT_ENCODING);
}

function normalizeModelName(modelName: string): TiktokenModel {
  const normalized = modelName.includes("/")
    ? (modelName.split("/").at(-1) ?? modelName)
    : modelName;
  return (
    MODEL_ENCODING_ALIASES.get(normalized) ?? (normalized as TiktokenModel)
  );
}

function readEnvelopeText(envelope: TransformEnvelope): string {
  return envelope.parts
    .flatMap((part) => {
      if (
        part.type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return [(part as { text: string }).text];
      }

      return [];
    })
    .join("\n")
    .trim();
}

function describeModel(modelName: string | undefined): string {
  return typeof modelName === "string" && modelName.trim().length > 0
    ? `model '${modelName}'`
    : "default encoding";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
