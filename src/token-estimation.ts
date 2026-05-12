import type { TransformEnvelope } from "./seams/noop-observation.js";
import { renderModelVisiblePartsText } from "./model-visible-transcript.js";

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_TIKTOKEN_ENDPOINT = "http://127.0.0.1:40311/count";
const DEFAULT_TIKTOKEN_TIMEOUT_MS = 1_000;

type TokenEstimateSource = "character-approximation" | "python-tiktoken";

export interface TokenEstimate {
  readonly tokenCount: number;
  readonly source: TokenEstimateSource;
}

export interface EstimateEnvelopeTokensOptions {
  readonly envelope: TransformEnvelope;
  readonly modelName?: string;
}

export interface EstimateEnvelopeTokensWithServiceOptions
  extends EstimateEnvelopeTokensOptions {
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

export function estimateEnvelopeTokens(
  options: EstimateEnvelopeTokensOptions,
): TokenEstimate {
  const content = readEnvelopeText(options.envelope);
  return {
    tokenCount: estimateTokenCountFromCharacters(content),
    source: "character-approximation",
  };
}

export async function estimateEnvelopeTokensWithService(
  options: EstimateEnvelopeTokensWithServiceOptions,
): Promise<TokenEstimate> {
  const content = readEnvelopeText(options.envelope);
  const serviceEstimate = await estimateTextTokensWithService({
    text: content,
    modelName: options.modelName,
    endpoint: options.endpoint,
    timeoutMs: options.timeoutMs,
  });

  if (serviceEstimate) {
    return serviceEstimate;
  }

  return {
    tokenCount: estimateTokenCountFromCharacters(content),
    source: "character-approximation",
  };
}

async function estimateTextTokensWithService(input: {
  readonly text: string;
  readonly modelName?: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}): Promise<TokenEstimate | undefined> {
  if (input.text.length === 0) {
    return { tokenCount: 0, source: "python-tiktoken" };
  }

  try {
    const response = await fetch(
      input.endpoint ??
        process.env.OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL ??
        DEFAULT_TIKTOKEN_ENDPOINT,
      {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: input.modelName, text: input.text }),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIKTOKEN_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      return undefined;
    }

    const payload = await response.json() as { readonly tokens?: unknown };
    return typeof payload.tokens === "number" && Number.isInteger(payload.tokens)
      ? { tokenCount: Math.max(0, payload.tokens), source: "python-tiktoken" }
      : undefined;
  } catch {
    return undefined;
  }
}

function estimateTokenCountFromCharacters(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  return Math.ceil(content.length / DEFAULT_CHARS_PER_TOKEN);
}

function readEnvelopeText(envelope: TransformEnvelope): string {
  return renderModelVisiblePartsText(envelope.parts);
}
