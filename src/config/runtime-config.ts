import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CompactionRoute } from "../state/store.js";

export const RUNTIME_CONFIG_ENV = Object.freeze({
  configPath: "OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH",
  promptPath: "OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH",
  models: "OPENCODE_CONTEXT_COMPRESSION_MODELS",
  route: "OPENCODE_CONTEXT_COMPRESSION_ROUTE",
  runtimeLogPath: "OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH",
  seamLogPath: "OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG",
  debugSnapshotPath: "OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH",
});

export interface RuntimeConfig {
  readonly repoRoot: string;
  readonly configPath: string;
  readonly promptPath: string;
  readonly promptText: string;
  readonly models: readonly string[];
  readonly route: CompactionRoute;
  readonly runtimeLogPath: string;
  readonly seamLogPath: string;
  readonly debugSnapshotPath?: string;
}

interface RuntimeConfigFile {
  readonly version: number;
  readonly promptPath: string;
  readonly compactionModels: readonly string[];
  readonly route: CompactionRoute;
  readonly runtimeLogPath: string;
  readonly seamLogPath: string;
}

export class OpencodeContextCompressionRuntimeConfigError extends Error {
  constructor(message: string) {
    super(`opencode-context-compression runtime config error: ${message}`);
    this.name = "OpencodeContextCompressionRuntimeConfigError";
  }
}

export function resolveRuntimeConfigRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function resolveDefaultRuntimeConfigPath(repoRoot = resolveRuntimeConfigRepoRoot()): string {
  return resolve(repoRoot, "src", "config", "runtime-config.json");
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const repoRoot = resolveRuntimeConfigRepoRoot();
  const configPath = readOptionalPathEnv(env, RUNTIME_CONFIG_ENV.configPath, repoRoot) ??
    resolveDefaultRuntimeConfigPath(repoRoot);
  const fileConfig = parseRuntimeConfigFile(configPath, repoRoot);
  const promptPath =
    readOptionalPathEnv(env, RUNTIME_CONFIG_ENV.promptPath, repoRoot) ?? fileConfig.promptPath;
  const runtimeLogPath =
    readOptionalPathEnv(env, RUNTIME_CONFIG_ENV.runtimeLogPath, repoRoot) ?? fileConfig.runtimeLogPath;
  const seamLogPath =
    readOptionalPathEnv(env, RUNTIME_CONFIG_ENV.seamLogPath, repoRoot) ?? fileConfig.seamLogPath;
  const debugSnapshotPath = readOptionalPathEnv(env, RUNTIME_CONFIG_ENV.debugSnapshotPath, repoRoot);
  const promptText = readPromptText(promptPath);
  const models = readModelsOverride(env, fileConfig.compactionModels);
  const route = readRouteOverride(env, fileConfig.route);

  return {
    repoRoot,
    configPath,
    promptPath,
    promptText,
    models,
    route,
    runtimeLogPath,
    seamLogPath,
    ...(debugSnapshotPath === undefined ? {} : { debugSnapshotPath }),
  };
}

function parseRuntimeConfigFile(configPath: string, repoRoot: string): RuntimeConfigFile {
  if (!existsSync(configPath)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Missing runtime config file at '${configPath}'. No legacy runtime-config fallback is supported.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' is malformed JSON: ${describeError(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' must be a JSON object.`,
    );
  }

  const version = parsed.version;
  if (version !== 1) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' must declare version 1, received '${String(version)}'.`,
    );
  }

  return {
    version,
    promptPath: resolveConfiguredPath(
      readRequiredNonEmptyString(parsed.promptPath, configPath, "promptPath"),
      repoRoot,
    ),
    compactionModels: readRequiredModelArray(parsed.compactionModels, configPath),
    route: readRequiredRoute(parsed.route, configPath, "route"),
    runtimeLogPath: resolveConfiguredPath(
      readRequiredNonEmptyString(parsed.runtimeLogPath, configPath, "runtimeLogPath"),
      repoRoot,
    ),
    seamLogPath: resolveConfiguredPath(
      readRequiredNonEmptyString(parsed.seamLogPath, configPath, "seamLogPath"),
      repoRoot,
    ),
  };
}

function readPromptText(promptPath: string): string {
  if (!existsSync(promptPath)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Missing prompt asset at '${promptPath}'. No builtin prompt fallback is supported.`,
    );
  }

  let promptText: string;
  try {
    promptText = readFileSync(promptPath, "utf8");
  } catch (error) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Failed to read prompt asset '${promptPath}': ${describeError(error)}`,
    );
  }

  if (promptText.trim().length === 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Prompt asset '${promptPath}' must contain non-empty prompt text.`,
    );
  }

  return promptText;
}

function readModelsOverride(
  env: NodeJS.ProcessEnv,
  fallback: readonly string[],
): readonly string[] {
  const value = readOptionalStringEnv(env, RUNTIME_CONFIG_ENV.models);
  if (value === undefined) {
    return fallback;
  }

  const models = value.split(",").map((entry) => entry.trim());
  if (models.some((entry) => entry.length === 0)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${RUNTIME_CONFIG_ENV.models} must be a comma-separated ordered model list without empty entries.`,
    );
  }

  if (models.length === 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${RUNTIME_CONFIG_ENV.models} must contain at least one model.`,
    );
  }

  return Object.freeze([...models]);
}

function readRouteOverride(
  env: NodeJS.ProcessEnv,
  fallback: CompactionRoute,
): CompactionRoute {
  const value = readOptionalStringEnv(env, RUNTIME_CONFIG_ENV.route);
  if (value === undefined) {
    return fallback;
  }

  return readRequiredRoute(value, RUNTIME_CONFIG_ENV.route, RUNTIME_CONFIG_ENV.route);
}

function readOptionalPathEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  repoRoot: string,
): string | undefined {
  const value = readOptionalStringEnv(env, name);
  if (value === undefined) {
    return undefined;
  }

  return resolveConfiguredPath(value, repoRoot);
}

function readOptionalStringEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${name} is set but empty. Unset the variable to use the repo-owned default or config-file value.`,
    );
  }

  return trimmed;
}

function resolveConfiguredPath(value: string, repoRoot: string): string {
  return resolve(repoRoot, value);
}

function readRequiredNonEmptyString(value: unknown, configPath: string, fieldName: string): string {
  if (typeof value !== "string") {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' field '${fieldName}' must be a string.`,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' field '${fieldName}' must not be empty.`,
    );
  }

  return trimmed;
}

function readRequiredModelArray(value: unknown, configPath: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' field 'compactionModels' must be an ordered string array.`,
    );
  }

  const models = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new OpencodeContextCompressionRuntimeConfigError(
        `Runtime config '${configPath}' field 'compactionModels[${index}]' must be a string.`,
      );
    }

    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw new OpencodeContextCompressionRuntimeConfigError(
        `Runtime config '${configPath}' field 'compactionModels[${index}]' must not be empty.`,
      );
    }

    return trimmed;
  });

  if (models.length === 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' field 'compactionModels' must contain at least one model.`,
    );
  }

  return Object.freeze(models);
}

function readRequiredRoute(value: unknown, sourcePath: string, fieldName: string): CompactionRoute {
  if (value !== "keep" && value !== "delete") {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${sourcePath} field '${fieldName}' must be either 'keep' or 'delete'.`,
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
