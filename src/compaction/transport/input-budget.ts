import { estimateTextTokensWithService } from "../../token-estimation.js";
import { CompactionTransportFatalError } from "./errors.js";

export function resolveCompactionInputBudget(limit: {
  readonly input?: number;
  readonly context?: number;
  readonly output?: number;
} | undefined): number | undefined {
  if (!limit) return undefined;
  const budget = limit.input ?? (
    limit.context !== undefined && limit.output !== undefined
      ? limit.context - limit.output
      : undefined
  );
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) {
    throw new CompactionTransportFatalError("Model input budget must be a positive integer.");
  }
  return budget;
}

export async function checkCompactionInputBudget(input: {
  readonly model: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly inputTokenLimit?: number;
}): Promise<void> {
  if (input.inputTokenLimit === undefined) return;
  const text = JSON.stringify([
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.userMessage },
  ]);
  const estimate = await estimateTextTokensWithService({
    modelName: input.model,
    text,
  });
  // Character/4 can undercount Chinese and code; bytes are a conservative fallback.
  const tokens = estimate?.tokenCount ?? Buffer.byteLength(text, "utf8");
  if (tokens > input.inputTokenLimit) {
    throw new CompactionTransportFatalError(
      `Assembled compaction input exceeds model budget (${tokens} estimated tokens > ${input.inputTokenLimit}); split the mark into independent complete ranges.`,
    );
  }
}
