import { createHash } from "node:crypto";

export const TOKEN_COUNT_CACHE_MAX_ENTRIES = 65_536;
const TOKEN_COUNT_CACHE_KEY_VERSION = 1;

export function buildTokenCountCacheKey(input: {
  readonly text: string;
  readonly endpoint: string;
  readonly modelName?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      TOKEN_COUNT_CACHE_KEY_VERSION,
      input.endpoint,
      input.modelName ?? null,
      input.text.length,
    ]))
    .update("\0")
    // UTF-16 preserves distinct lone surrogates that UTF-8 would replace alike.
    .update(input.text, "utf16le")
    .digest("hex");
}

export function createTokenCountCache(maxEntries = TOKEN_COUNT_CACHE_MAX_ENTRIES): {
  get(key: string): number | undefined;
  set(key: string, tokenCount: number): void;
} {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError("Token count cache capacity must be a positive integer.");
  }
  const entries = new Map<string, number>();
  return {
    get(key) {
      const tokenCount = entries.get(key);
      if (tokenCount !== undefined) {
        entries.delete(key);
        entries.set(key, tokenCount);
      }
      return tokenCount;
    },
    set(key, tokenCount) {
      entries.delete(key);
      entries.set(key, tokenCount);
      if (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) entries.delete(oldestKey);
      }
    },
  };
}
