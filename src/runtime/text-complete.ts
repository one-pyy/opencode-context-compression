import type { Hooks } from "@opencode-ai/plugin";

type TextCompleteHook = NonNullable<Hooks["experimental.text.complete"]>;

export type TextCompleteInput = Parameters<TextCompleteHook>[0];
export type TextCompleteOutput = Parameters<TextCompleteHook>[1];

const LEADING_VISIBLE_ID_PATTERN =
  /^\[(?:protected|compressible|referable)_\d{6}_[0-9A-Za-z]{2,}\](?:\s)*/u;

export function stripLeadingVisibleMessageId(text: string): string {
  return text.replace(LEADING_VISIBLE_ID_PATTERN, "");
}

export function createTextCompleteHook(): TextCompleteHook {
  return async (_input, output) => {
    // The host runs this seam after assistant text streaming completes.
    // Strip any model-visible msg_id prefix here so replay-visible IDs do not leak into the final reply.
    output.text = stripLeadingVisibleMessageId(output.text);
  };
}
