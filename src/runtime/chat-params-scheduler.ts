import type { Hooks } from "@opencode-ai/plugin";

/**
 * TODO(new-project): rewrite chat.params scheduler as a narrow DESIGN seam.
 *
 * Direction:
 * - resync canonical history
 * - compute readiness from the new replay/result-group model
 * - dispatch background compaction without depending on legacy mark tables
 * - do not reintroduce old activeMarks/sourceSnapshot scheduling
 */
export function createChatParamsSchedulerHook(): NonNullable<Hooks["chat.params"]> {
  return async () => {
    throw new Error(
      "TODO(new-project): chat.params scheduler was stripped and must be rebuilt from DESIGN.md.",
    );
  };
}
