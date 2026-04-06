import type { Hooks } from "@opencode-ai/plugin";

/**
 * TODO(new-project): rewrite send-entry gate from DESIGN.md.
 *
 * Direction:
 * - ordinary chat waits before entering the send path
 * - non-blocked tools continue according to the new runtime model
 * - remove legacy batch lookup and internal-tool branching tied to the old runtime tables
 */
export function createSendEntryGateHooks(): Pick<Hooks, "chat.message" | "tool.execute.before"> {
  return {
    "chat.message": async () => {
      throw new Error(
        "TODO(new-project): send-entry gate was stripped and must be rebuilt from DESIGN.md.",
      );
    },
    "tool.execute.before": async () => {
      throw new Error(
        "TODO(new-project): send-entry gate was stripped and must be rebuilt from DESIGN.md.",
      );
    },
  };
}
