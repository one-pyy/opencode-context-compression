import type { Hooks } from "@opencode-ai/plugin";

/**
 * TODO(new-project): rewrite messages.transform around the new DESIGN runtime.
 *
 * Direction:
 * - resync canonical host history
 * - run the new projection-builder
 * - materialize visible ids in a single exit
 * - keep assistant/tool prefix rules from DESIGN.md
 * - do not restore the stripped legacy projection pipeline
 */
export function createMessagesTransformHook(): NonNullable<Hooks["experimental.chat.messages.transform"]> {
  return async () => {
    throw new Error(
      "TODO(new-project): messages.transform was stripped and must be rebuilt from DESIGN.md.",
    );
  };
}
