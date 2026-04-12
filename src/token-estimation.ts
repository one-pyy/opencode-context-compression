import type { TransformEnvelope } from "./seams/noop-observation.js";

const DEFAULT_CHARS_PER_TOKEN = 4;

type TokenEstimateSource = "character-approximation";

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
  return {
    tokenCount: estimateTokenCountFromCharacters(content),
    source: "character-approximation",
  };
}

function estimateTokenCountFromCharacters(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  return Math.ceil(content.length / DEFAULT_CHARS_PER_TOKEN);
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
