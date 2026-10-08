import type { TransformEnvelope } from "./seams/noop-observation.js";
import { renderModelVisiblePartsText } from "./model-visible-transcript.js";
import { buildTokenCountCacheKey, createTokenCountCache } from "./token-estimation-cache.js";
import { getPerformanceTrace } from "./performance-diagnostics.js";

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_TIKTOKEN_ENDPOINT = "http://127.0.0.1:40311/count";
const DEFAULT_TIKTOKEN_TIMEOUT_MS = 1_000;
const serviceTokenCountCache = createTokenCountCache();

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

export async function estimateTextTokensWithService(input: {
  readonly text: string;
  readonly modelName?: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}): Promise<TokenEstimate | undefined> {
  const metrics = getPerformanceTrace()?.tokens;
  if (metrics) {
    metrics.calls += 1;
    metrics.textCharacters += input.text.length;
  }
  if (input.text.length === 0) {
    return { tokenCount: 0, source: "python-tiktoken" };
  }

  try {
    const endpoint = input.endpoint ??
      process.env.OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL ??
      DEFAULT_TIKTOKEN_ENDPOINT;
    const hashStarted = metrics ? performance.now() : 0;
    const cacheKey = buildTokenCountCacheKey({
      text: input.text,
      endpoint,
      modelName: input.modelName,
    });
    if (metrics) metrics.hashMs += performance.now() - hashStarted;
    const cachedTokenCount = serviceTokenCountCache.get(cacheKey);
    if (cachedTokenCount !== undefined) {
      if (metrics) metrics.hits += 1;
      return { tokenCount: cachedTokenCount, source: "python-tiktoken" };
    }
    if (metrics) {
      metrics.misses += 1;
      metrics.requests += 1;
    }
    const response = await fetch(
      endpoint,
      {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: input.modelName, text: input.text }),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIKTOKEN_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      if (metrics) metrics.failures += 1;
      return undefined;
    }

    const payload = await response.json() as { readonly tokens?: unknown };
    if (typeof payload.tokens !== "number" || !Number.isInteger(payload.tokens)) {
      if (metrics) metrics.failures += 1;
      return undefined;
    }
    const tokenCount = Math.max(0, payload.tokens);
    serviceTokenCountCache.set(cacheKey, tokenCount);
    return { tokenCount, source: "python-tiktoken" };
  } catch {
    if (metrics) metrics.failures += 1;
    return undefined;
  }
}

export async function estimateTextTokenCount(text: string): Promise<number> {
  const estimate = await estimateTextTokensWithService({ text });
  return estimate?.tokenCount ?? estimateTokenCountFromCharacters(text);
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
