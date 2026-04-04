import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { DEFAULT_LOCK_TIMEOUT_MS } from "../runtime/file-lock.js";
import type { CompactionRoute } from "../state/store.js";

const DEFAULT_SCHEDULER_MARK_THRESHOLD = 1;
const DEFAULT_MARKED_TOKEN_AUTO_COMPACTION_THRESHOLD = 20_000;
const DEFAULT_SMALL_USER_MESSAGE_THRESHOLD = 1_024;
const DEFAULT_REMINDER_HSOFT = 30_000;
const DEFAULT_REMINDER_HHARD = 70_000;
const DEFAULT_REMINDER_COUNTER_SOURCE = "eligible_messages";
const DEFAULT_SOFT_REMINDER_REPEAT_EVERY = 3;
const DEFAULT_HARD_REMINDER_REPEAT_EVERY = 1;
const DEFAULT_RUNTIME_LOG_LEVEL = "off";
const DEFAULT_COMPRESSING_TIMEOUT_SECONDS = Math.floor(
  DEFAULT_LOCK_TIMEOUT_MS / 1_000,
);

export const RUNTIME_CONFIG_ENV = Object.freeze({
  configPath: "OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH",
  promptPath: "OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH",
  models: "OPENCODE_CONTEXT_COMPRESSION_MODELS",
  route: "OPENCODE_CONTEXT_COMPRESSION_ROUTE",
  runtimeLogPath: "OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH",
  seamLogPath: "OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG",
  logLevel: "OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL",
  compressingTimeoutSeconds:
    "OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS",
  debugSnapshotPath: "OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH",
});

export type RuntimeLogLevel = "off" | "error" | "info" | "debug";
export type ReminderCounterSource = "eligible_messages" | "assistant_turns";

export interface ReminderCounterRule {
  readonly repeatEvery: number;
}

export interface ReminderCounterConfig {
  readonly source: ReminderCounterSource;
  readonly soft: ReminderCounterRule;
  readonly hard: ReminderCounterRule;
}

export interface ReminderPromptConfig {
  readonly softPath: string;
  readonly softText: string;
  readonly hardPath: string;
  readonly hardText: string;
}

export interface ReminderRuntimeConfig {
  readonly hsoft: number;
  readonly hhard: number;
  readonly counter: ReminderCounterConfig;
  readonly prompts: ReminderPromptConfig;
}

export interface LoggingRuntimeConfig {
  readonly level: RuntimeLogLevel;
}

export interface CompressingRuntimeConfig {
  readonly timeoutSeconds: number;
  readonly timeoutMs: number;
}

export interface RuntimeConfig {
  readonly repoRoot: string;
  readonly configPath: string;
  readonly promptPath: string;
  readonly promptText: string;
  readonly models: readonly string[];
  readonly markedTokenAutoCompactionThreshold: number;
  readonly smallUserMessageThreshold: number;
  readonly reminder: ReminderRuntimeConfig;
  readonly logging: LoggingRuntimeConfig;
  readonly compressing: CompressingRuntimeConfig;
  readonly schedulerMarkThreshold: number;
  readonly route: CompactionRoute;
  readonly runtimeLogPath: string;
  readonly seamLogPath: string;
  readonly debugSnapshotPath?: string;
}

interface RuntimeConfigFile {
  readonly $schema?: string;
  readonly version: number;
  readonly promptPath: string;
  readonly compactionModels: readonly string[];
  readonly markedTokenAutoCompactionThreshold: number;
  readonly smallUserMessageThreshold: number;
  readonly reminder: ReminderRuntimeConfig;
  readonly logging: LoggingRuntimeConfig;
  readonly compressing: CompressingRuntimeConfig;
  readonly schedulerMarkThreshold: number;
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

export function resolveDefaultRuntimeConfigPath(
  repoRoot = resolveRuntimeConfigRepoRoot(),
): string {
  return resolve(repoRoot, "src", "config", "runtime-config.jsonc");
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const repoRoot = resolveRuntimeConfigRepoRoot();
  const configPath =
    readOptionalPathEnv(env, RUNTIME_CONFIG_ENV.configPath, repoRoot) ??
    resolveDefaultRuntimeConfigPath(repoRoot);
  const fileConfig = parseRuntimeConfigFile(configPath, repoRoot);
  const promptPath =
    readOptionalPathEnv(env, RUNTIME_CONFIG_ENV.promptPath, repoRoot) ??
    fileConfig.promptPath;
  const runtimeLogPath =
    readOptionalPathEnv(env, RUNTIME_CONFIG_ENV.runtimeLogPath, repoRoot) ??
    fileConfig.runtimeLogPath;
  const seamLogPath =
    readOptionalPathEnv(env, RUNTIME_CONFIG_ENV.seamLogPath, repoRoot) ??
    fileConfig.seamLogPath;
  const loggingLevel = readLogLevelOverride(env, fileConfig.logging.level);
  const timeoutSeconds =
    readOptionalPositiveIntegerEnv(
      env,
      RUNTIME_CONFIG_ENV.compressingTimeoutSeconds,
    ) ?? fileConfig.compressing.timeoutSeconds;
  const debugSnapshotPath = readOptionalPathEnv(
    env,
    RUNTIME_CONFIG_ENV.debugSnapshotPath,
    repoRoot,
  );
  const promptText = readPromptText(promptPath);
  const models = readModelsOverride(env, fileConfig.compactionModels);
  const route = readRouteOverride(env, fileConfig.route);

  return {
    repoRoot,
    configPath,
    promptPath,
    promptText,
    models,
    markedTokenAutoCompactionThreshold:
      fileConfig.markedTokenAutoCompactionThreshold,
    smallUserMessageThreshold: fileConfig.smallUserMessageThreshold,
    reminder: fileConfig.reminder,
    logging: {
      level: loggingLevel,
    },
    compressing: {
      timeoutSeconds,
      timeoutMs: timeoutSeconds * 1_000,
    },
    schedulerMarkThreshold: fileConfig.schedulerMarkThreshold,
    route,
    runtimeLogPath,
    seamLogPath,
    ...(debugSnapshotPath === undefined ? {} : { debugSnapshotPath }),
  };
}

function parseRuntimeConfigFile(
  configPath: string,
  repoRoot: string,
): RuntimeConfigFile {
  if (!existsSync(configPath)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Missing runtime config file at '${configPath}'. No legacy runtime-config fallback is supported.`,
    );
  }

  let configText: string;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Failed to read runtime config '${configPath}': ${describeError(error)}`,
    );
  }

  const parseErrors: ParseError[] = [];
  const parsed = parse(configText, parseErrors);

  if (parseErrors.length > 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' contains invalid JSON/JSONC syntax: ${describeJsoncParseError(configText, parseErrors[0])}.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' must be an object.`,
    );
  }

  const version = parsed.version;
  if (version !== 1) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' must declare version 1, received '${String(version)}'.`,
    );
  }

  const reminderConfig = readOptionalRecord(
    parsed.reminder,
    configPath,
    "reminder",
  );
  const reminderPromptPaths = readOptionalRecord(
    reminderConfig?.promptPaths,
    configPath,
    "reminder.promptPaths",
  );
  const reminderCounter = readOptionalRecord(
    reminderConfig?.counter,
    configPath,
    "reminder.counter",
  );
  const reminderCounterSoft = readOptionalRecord(
    reminderCounter?.soft,
    configPath,
    "reminder.counter.soft",
  );
  const reminderCounterHard = readOptionalRecord(
    reminderCounter?.hard,
    configPath,
    "reminder.counter.hard",
  );
  const loggingConfig = readOptionalRecord(
    parsed.logging,
    configPath,
    "logging",
  );
  const compressingConfig = readOptionalRecord(
    parsed.compressing,
    configPath,
    "compressing",
  );

  const reminderHsoft =
    readOptionalPositiveInteger(
      reminderConfig?.hsoft,
      configPath,
      "reminder.hsoft",
    ) ?? DEFAULT_REMINDER_HSOFT;
  const reminderHhard =
    readOptionalPositiveInteger(
      reminderConfig?.hhard,
      configPath,
      "reminder.hhard",
    ) ?? DEFAULT_REMINDER_HHARD;

  if (reminderHhard < reminderHsoft) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' must satisfy reminder.hhard >= reminder.hsoft.`,
    );
  }

  const softPromptPath = resolveConfiguredPath(
    readOptionalNonEmptyString(
      reminderPromptPaths?.soft,
      configPath,
      "reminder.promptPaths.soft",
    ) ?? "prompts/reminder-soft.md",
    repoRoot,
  );
  const hardPromptPath = resolveConfiguredPath(
    readOptionalNonEmptyString(
      reminderPromptPaths?.hard,
      configPath,
      "reminder.promptPaths.hard",
    ) ?? "prompts/reminder-hard.md",
    repoRoot,
  );

  const softPromptText = readPromptText(softPromptPath);
  const hardPromptText = readPromptText(hardPromptPath);
  const timeoutSeconds =
    readOptionalPositiveInteger(
      compressingConfig?.timeoutSeconds,
      configPath,
      "compressing.timeoutSeconds",
    ) ?? DEFAULT_COMPRESSING_TIMEOUT_SECONDS;

  return {
    version,
    promptPath: resolveConfiguredPath(
      readRequiredNonEmptyString(parsed.promptPath, configPath, "promptPath"),
      repoRoot,
    ),
    compactionModels: readRequiredModelArray(
      parsed.compactionModels,
      configPath,
    ),
    markedTokenAutoCompactionThreshold:
      readOptionalPositiveInteger(
        parsed.markedTokenAutoCompactionThreshold,
        configPath,
        "markedTokenAutoCompactionThreshold",
      ) ?? DEFAULT_MARKED_TOKEN_AUTO_COMPACTION_THRESHOLD,
    smallUserMessageThreshold:
      readOptionalPositiveInteger(
        parsed.smallUserMessageThreshold,
        configPath,
        "smallUserMessageThreshold",
      ) ?? DEFAULT_SMALL_USER_MESSAGE_THRESHOLD,
    reminder: {
      hsoft: reminderHsoft,
      hhard: reminderHhard,
      counter: {
        source:
          readOptionalReminderCounterSource(
            reminderCounter?.source,
            configPath,
            "reminder.counter.source",
          ) ?? DEFAULT_REMINDER_COUNTER_SOURCE,
        soft: {
          repeatEvery:
            readOptionalPositiveInteger(
              reminderCounterSoft?.repeatEvery,
              configPath,
              "reminder.counter.soft.repeatEvery",
            ) ?? DEFAULT_SOFT_REMINDER_REPEAT_EVERY,
        },
        hard: {
          repeatEvery:
            readOptionalPositiveInteger(
              reminderCounterHard?.repeatEvery,
              configPath,
              "reminder.counter.hard.repeatEvery",
            ) ?? DEFAULT_HARD_REMINDER_REPEAT_EVERY,
        },
      },
      prompts: {
        softPath: softPromptPath,
        softText: softPromptText,
        hardPath: hardPromptPath,
        hardText: hardPromptText,
      },
    },
    logging: {
      level:
        readOptionalLogLevel(
          loggingConfig?.level,
          configPath,
          "logging.level",
        ) ?? DEFAULT_RUNTIME_LOG_LEVEL,
    },
    compressing: {
      timeoutSeconds,
      timeoutMs: timeoutSeconds * 1_000,
    },
    schedulerMarkThreshold:
      readOptionalPositiveInteger(
        parsed.schedulerMarkThreshold,
        configPath,
        "schedulerMarkThreshold",
      ) ?? DEFAULT_SCHEDULER_MARK_THRESHOLD,
    route: readRequiredRoute(parsed.route, configPath, "route"),
    runtimeLogPath: resolveConfiguredPath(
      readRequiredNonEmptyString(
        parsed.runtimeLogPath,
        configPath,
        "runtimeLogPath",
      ),
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

  return readRequiredRoute(
    value,
    RUNTIME_CONFIG_ENV.route,
    RUNTIME_CONFIG_ENV.route,
  );
}

function readLogLevelOverride(
  env: NodeJS.ProcessEnv,
  fallback: RuntimeLogLevel,
): RuntimeLogLevel {
  const value = readOptionalStringEnv(env, RUNTIME_CONFIG_ENV.logLevel);
  if (value === undefined) {
    return fallback;
  }

  return readRequiredLogLevel(
    value,
    RUNTIME_CONFIG_ENV.logLevel,
    RUNTIME_CONFIG_ENV.logLevel,
  );
}

function readOptionalPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const value = readOptionalStringEnv(env, name);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${name} must be a positive integer.`,
    );
  }

  return parsed;
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

function readOptionalStringEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
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

function readOptionalRecord(
  value: unknown,
  sourcePath: string,
  fieldName: string,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${sourcePath}' field '${fieldName}' must be an object.`,
    );
  }

  return value;
}

function readRequiredNonEmptyString(
  value: unknown,
  configPath: string,
  fieldName: string,
): string {
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

function readOptionalNonEmptyString(
  value: unknown,
  configPath: string,
  fieldName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredNonEmptyString(value, configPath, fieldName);
}

function readRequiredModelArray(
  value: unknown,
  configPath: string,
): readonly string[] {
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

function readRequiredRoute(
  value: unknown,
  sourcePath: string,
  fieldName: string,
): CompactionRoute {
  if (value !== "keep" && value !== "delete") {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${sourcePath} field '${fieldName}' must be either 'keep' or 'delete'.`,
    );
  }

  return value;
}

function readRequiredLogLevel(
  value: unknown,
  sourcePath: string,
  fieldName: string,
): RuntimeLogLevel {
  if (
    value !== "off" &&
    value !== "error" &&
    value !== "info" &&
    value !== "debug"
  ) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${sourcePath} field '${fieldName}' must be one of 'off', 'error', 'info', or 'debug'.`,
    );
  }

  return value;
}

function readOptionalLogLevel(
  value: unknown,
  sourcePath: string,
  fieldName: string,
): RuntimeLogLevel | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredLogLevel(value, sourcePath, fieldName);
}

function readRequiredPositiveInteger(
  value: unknown,
  sourcePath: string,
  fieldName: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${sourcePath} field '${fieldName}' must be a positive integer.`,
    );
  }

  return value;
}

function readOptionalPositiveInteger(
  value: unknown,
  sourcePath: string,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredPositiveInteger(value, sourcePath, fieldName);
}

function readOptionalReminderCounterSource(
  value: unknown,
  sourcePath: string,
  fieldName: string,
): ReminderCounterSource | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== "eligible_messages" && value !== "assistant_turns") {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${sourcePath} field '${fieldName}' must be either 'eligible_messages' or 'assistant_turns'.`,
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

function describeJsoncParseError(sourceText: string, error: ParseError): string {
  const location = describeTextLocation(sourceText, error.offset);
  return `${printParseErrorCode(error.error)} at line ${location.line}, column ${location.column}`;
}

function describeTextLocation(sourceText: string, offset: number): {
  line: number;
  column: number;
} {
  let line = 1;
  let column = 1;

  for (let index = 0; index < Math.min(offset, sourceText.length); index += 1) {
    if (sourceText[index] === "\n") {
      line += 1;
      column = 1;
      continue;
    }

    column += 1;
  }

  return { line, column };
}
