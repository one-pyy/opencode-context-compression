const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Utility class for counting tokens and calculating compression ratios.
 * Uses simple character-based estimation (chars/4) for token counting.
 */
export class TokenCounter {
  /**
   * Count tokens in a text string using character-based estimation.
   * @param text - The text to count tokens for
   * @returns Estimated token count
   */
  countTokens(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    return Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN);
  }

  /**
   * Calculate the number of tokens saved after compression.
   * @param beforeTokens - Token count before compression
   * @param afterTokens - Token count after compression
   * @returns Number of tokens saved (beforeTokens - afterTokens)
   */
  calculateCompressionRatio(beforeTokens: number, afterTokens: number): number {
    return beforeTokens - afterTokens;
  }
}
