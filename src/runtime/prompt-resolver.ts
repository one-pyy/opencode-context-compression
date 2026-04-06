import { resolveReminderPrompt } from "../config/runtime-config.js";
import { defineInternalModuleContract } from "../internal/module-contract.js";
import type {
  ResolvedRuntimeConfig,
  RuntimeConfigLoader,
} from "./runtime-config-loader.js";

export type ReminderPromptKind =
  | "soft-compact"
  | "soft-delete"
  | "hard-compact"
  | "hard-delete";

export interface PromptResolver {
  resolveReminder(kind: ReminderPromptKind): Promise<string>;
  resolveCompactionPrompt(): Promise<string>;
}

export const PROMPT_RESOLVER_INTERNAL_CONTRACT = defineInternalModuleContract({
  module: "PromptResolver",
  inputs: ["ReminderPromptKind", "ResolvedRuntimeConfig"],
  outputs: ["reminder prompt text", "compaction prompt text"],
  mutability: "read-only",
  reads: ["resolved reminder prompt assets", "resolved compaction prompt asset"],
  writes: [],
  errorTypes: ["OpencodeContextCompressionRuntimeConfigError"],
  idempotency:
    "Idempotent for the same resolved runtime config and prompt selection input.",
  dependencyDirection: {
    inboundFrom: ["external-adapters"],
    outboundTo: ["RuntimeConfigLoader"],
  },
});

export function createPromptResolver(
  config: ResolvedRuntimeConfig,
): PromptResolver {
  return {
    async resolveReminder(kind) {
      const severity = kind.startsWith("soft") ? "soft" : "hard";
      const allowDelete = kind.endsWith("delete");
      return resolveReminderPrompt(config, {
        severity,
        allowDelete,
      }).text;
    },
    async resolveCompactionPrompt() {
      return config.promptText;
    },
  } satisfies PromptResolver;
}

export async function createPromptResolverFromLoader(
  loader: RuntimeConfigLoader,
  sessionId: string,
): Promise<PromptResolver> {
  return createPromptResolver(await loader.load(sessionId));
}
