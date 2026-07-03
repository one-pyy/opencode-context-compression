export interface ReplacementGateInput {
  readonly uncompressedMarkedTokenCount: number;
  readonly markedTokenAutoCompactionThreshold: number;
  readonly lastModelResponseTime: number | undefined;
  readonly idleThresholdMs: number;
  readonly now: number;
}

export interface ReplacementGateResult {
  readonly shouldReplace: boolean;
  readonly reason: string;
}

export function evaluateReplacementGate(
  input: ReplacementGateInput,
): ReplacementGateResult {
  if (
    input.uncompressedMarkedTokenCount >= input.markedTokenAutoCompactionThreshold
  ) {
    return {
      shouldReplace: true,
      reason: `token threshold met (${input.uncompressedMarkedTokenCount} >= ${input.markedTokenAutoCompactionThreshold})`,
    };
  }

  if (
    input.lastModelResponseTime !== undefined &&
    input.now - input.lastModelResponseTime >= input.idleThresholdMs
  ) {
    return {
      shouldReplace: true,
      reason: `idle threshold met (${input.now - input.lastModelResponseTime}ms since last model response)`,
    };
  }

  return {
    shouldReplace: false,
    reason: `no threshold met (tokens: ${input.uncompressedMarkedTokenCount}/${input.markedTokenAutoCompactionThreshold}, idle: ${input.lastModelResponseTime === undefined ? "unknown" : `${input.now - input.lastModelResponseTime}ms`}/${input.idleThresholdMs}ms)`,
  };
}

interface PartLike {
  readonly type?: string;
  readonly time?: { readonly start?: number; readonly end?: number } | null;
}

interface MessageLike {
  readonly parts?: readonly PartLike[];
}

export function extractLastModelResponseTime(
  messages: readonly MessageLike[],
): number | undefined {
  let lastEnd: number | undefined;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message.parts) continue;

    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j];
      if (!part.time || part.time.end === undefined || part.time.end === null) continue;
      if (part.type === "text" || part.type === "reasoning") {
        if (lastEnd === undefined || part.time.end > lastEnd) {
          lastEnd = part.time.end;
        }
      }
    }

    if (lastEnd !== undefined) break;
  }

  return lastEnd;
}
