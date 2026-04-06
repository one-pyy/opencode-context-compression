import {
  loadRuntimeConfig,
  type LoadedRuntimeConfig,
} from "../config/runtime-config.js";
import { defineInternalModuleContract } from "../internal/module-contract.js";

export type ResolvedRuntimeConfig = LoadedRuntimeConfig;

export interface RuntimeConfigLoader {
  load(sessionId: string): Promise<ResolvedRuntimeConfig>;
}

export const RUNTIME_CONFIG_LOADER_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "RuntimeConfigLoader",
    inputs: ["sessionId"],
    outputs: ["ResolvedRuntimeConfig"],
    mutability: "read-only",
    reads: [
      "repo-owned runtime-config.jsonc and prompt assets",
      "field-level environment overrides",
    ],
    writes: [],
    errorTypes: ["OpencodeContextCompressionRuntimeConfigError"],
    idempotency:
      "Idempotent for the same repo config files and environment snapshot.",
    dependencyDirection: {
      inboundFrom: ["external-adapters", "PromptResolver"],
      outboundTo: [],
    },
  });

export function createRuntimeConfigLoader(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfigLoader {
  return {
    async load() {
      return loadRuntimeConfig(env);
    },
  } satisfies RuntimeConfigLoader;
}
