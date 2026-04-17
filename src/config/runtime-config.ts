import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ParseError = { error: number; offset: number; length: number };

function parseJsonc(source: string): unknown {
  // Strip single-line comments (// ...) and block comments (/* ... */),
  // then remove trailing commas before ] or }, then parse as JSON.
  const stripped = source
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

export const RUNTIME_CONFIG_ENV = {
  configPath: "OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH",
  promptPath: "OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH",
  models: "OPENCODE_CONTEXT_COMPRESSION_MODELS",
  runtimeLogPath: "OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH",
  seamLogPath: "OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG",
  logLevel: "OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL",
  compressingTimeoutSeconds:
    "OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS",
  debugSnapshotPath: "OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH",
} as const;

type RuntimeLogLevel = "off" | "error" | "info" | "debug";
type ReminderSeverity = "soft" | "hard";

interface ReminderPromptPathVariantInput {
  readonly soft?: unknown;
  readonly hard?: unknown;
}

interface ReminderPromptPathsInput {
  readonly compactOnly?: ReminderPromptPathVariantInput;
  readonly deleteAllowed?: ReminderPromptPathVariantInput;
}

interface RuntimeConfigInput {
  readonly $schema?: unknown;
  readonly version?: unknown;
  readonly allowDelete?: unknown;
  readonly promptPath?: unknown;
  readonly compactionModels?: unknown;
  readonly markedTokenAutoCompactionThreshold?: unknown;
  readonly smallUserMessageThreshold?: unknown;
  readonly schedulerMarkThreshold?: unknown;
  readonly runtimeLogPath?: unknown;
  readonly seamLogPath?: unknown;
  readonly logging?: {
    readonly level?: unknown;
  };
  readonly compressing?: {
    readonly timeoutSeconds?: unknown;
  };
  readonly reminder?: {
    readonly hsoft?: unknown;
    readonly hhard?: unknown;
    readonly softRepeatEveryTokens?: unknown;
    readonly hardRepeatEveryTokens?: unknown;
    readonly promptPaths?: ReminderPromptPathsInput;
  };
  readonly toast?: {
    readonly enabled?: unknown;
    readonly durations?: {
      readonly startup?: unknown;
      readonly softReminder?: unknown;
      readonly hardReminder?: unknown;
      readonly compressionStart?: unknown;
      readonly compressionComplete?: unknown;
      readonly compressionFailed?: unknown;
    };
  };
}

export interface LoadedPromptAsset {
  readonly path: string;
  readonly text: string;
}

export interface ResolvedRuntimeReminderPrompts {
  readonly compactOnly: {
    readonly soft: LoadedPromptAsset;
    readonly hard: LoadedPromptAsset;
  };
  readonly deleteAllowed: {
    readonly soft: LoadedPromptAsset;
    readonly hard: LoadedPromptAsset;
  };
}

export interface RuntimeConfigReminderThresholds {
  readonly hsoft: number;
  readonly hhard: number;
  readonly softRepeatEveryTokens: number;
  readonly hardRepeatEveryTokens: number;
}

export interface RuntimeConfigCompactionThresholds {
  readonly markedTokenAutoCompactionThreshold: number;
  readonly schedulerMarkThreshold: number;
  readonly smallUserMessageThreshold: number;
}

export interface LoadedRuntimeConfig {
  readonly repoRoot: string;
  readonly configPath: string;
  readonly allowDelete: boolean;
  readonly promptPath: string;
  readonly promptText: string;
  readonly models: readonly string[];
  readonly markedTokenAutoCompactionThreshold: number;
  readonly smallUserMessageThreshold: number;
  readonly schedulerMarkThreshold: number;
  readonly runtimeLogPath: string;
  readonly seamLogPath: string;
  readonly debugSnapshotPath?: string;
  readonly logging: {
    readonly level: RuntimeLogLevel;
  };
  readonly compressing: {
    readonly timeoutSeconds: number;
    readonly timeoutMs: number;
  };
  readonly reminder: RuntimeConfigReminderThresholds & {
    readonly promptPaths: {
      readonly compactOnly: {
        readonly soft: string;
        readonly hard: string;
      };
      readonly deleteAllowed: {
        readonly soft: string;
        readonly hard: string;
      };
    };
    readonly prompts: ResolvedRuntimeReminderPrompts;
  };
  readonly toast: {
    readonly enabled: boolean;
    readonly durations: {
      readonly startup: number;
      readonly softReminder: number;
      readonly hardReminder: number;
      readonly compressionStart: number;
      readonly compressionComplete: number;
      readonly compressionFailed: number;
    };
  };
}

export class OpencodeContextCompressionRuntimeConfigError extends Error {
  constructor(message: string) {
    super(`opencode-context-compression runtime config error: ${message}`);
    this.name = "OpencodeContextCompressionRuntimeConfigError";
  }
}

const DEFAULT_RUNTIME_CONFIG_PATH = join(
  "src",
  "config",
  "runtime-config.jsonc",
);

const DEFAULTS = {
  allowDelete: false,
  markedTokenAutoCompactionThreshold: 20_000,
  smallUserMessageThreshold: 1_024,
  schedulerMarkThreshold: 1,
  reminder: {
    hsoft: 30_000,
    hhard: 70_000,
    softRepeatEveryTokens: 20_000,
    hardRepeatEveryTokens: 10_000,
    promptPaths: {
      compactOnly: {
        soft: "prompts/reminder-soft-compact-only.md",
        hard: "prompts/reminder-hard-compact-only.md",
      },
      deleteAllowed: {
        soft: "prompts/reminder-soft-delete-allowed.md",
        hard: "prompts/reminder-hard-delete-allowed.md",
      },
    },
  },
  logging: {
    level: "off" as RuntimeLogLevel,
  },
  compressing: {
    timeoutSeconds: 600,
  },
  toast: {
    enabled: true,
    durations: {
      startup: 3000,
      softReminder: 5000,
      hardReminder: 7000,
      compressionStart: 3000,
      compressionComplete: 4000,
      compressionFailed: 5000,
    },
  },
} as const;

const ALLOWED_ROOT_KEYS = new Set([
  "$schema",
  "version",
  "allowDelete",
  "promptPath",
  "compactionModels",
  "markedTokenAutoCompactionThreshold",
  "smallUserMessageThreshold",
  "schedulerMarkThreshold",
  "runtimeLogPath",
  "seamLogPath",
  "logging",
  "compressing",
  "reminder",
  "toast",
]);

const ALLOWED_LOGGING_KEYS = new Set(["level"]);
const ALLOWED_COMPRESSING_KEYS = new Set(["timeoutSeconds"]);
const ALLOWED_REMINDER_KEYS = new Set([
  "hsoft",
  "hhard",
  "softRepeatEveryTokens",
  "hardRepeatEveryTokens",
  "promptPaths",
]);
const ALLOWED_REMINDER_PROMPT_KEYS = new Set(["compactOnly", "deleteAllowed"]);
const ALLOWED_REMINDER_VARIANT_KEYS = new Set(["soft", "hard"]);
const ALLOWED_TOAST_KEYS = new Set(["enabled", "durations"]);
const ALLOWED_TOAST_DURATION_KEYS = new Set([
  "startup",
  "softReminder",
  "hardReminder",
  "compressionStart",
  "compressionComplete",
  "compressionFailed",
]);
const LOG_LEVELS: readonly RuntimeLogLevel[] = ["off", "error", "info", "debug"];
const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{[^}]+\}\}/u;

export function resolveRuntimeConfigRepoRoot(): string {
  const sourcePath = fileURLToPath(import.meta.url);
  return resolve(dirname(sourcePath), "..", "..");
}

export async function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedRuntimeConfig> {
  const repoRoot = resolveRuntimeConfigRepoRoot();
  const configPath = resolveConfigFilePath(env, repoRoot);
  const parsed = await parseRuntimeConfigFile(configPath);

  const promptPath = resolveRuntimePathFromRepoRoot(
    readOptionalEnv(env, RUNTIME_CONFIG_ENV.promptPath) ??
      readRequiredString(parsed.promptPath, "promptPath"),
    { repoRoot, fieldPath: "promptPath" },
  );
  const modelsOverride = readOptionalEnv(env, RUNTIME_CONFIG_ENV.models);
  const runtimeLogOverride = readOptionalEnv(env, RUNTIME_CONFIG_ENV.runtimeLogPath);
  const seamLogOverride = readOptionalEnv(env, RUNTIME_CONFIG_ENV.seamLogPath);
  const logLevelOverride = readOptionalEnv(env, RUNTIME_CONFIG_ENV.logLevel);
  const timeoutOverride = readOptionalEnv(
    env,
    RUNTIME_CONFIG_ENV.compressingTimeoutSeconds,
  );
  const allowDeleteOverride = readOptionalEnv(env, "OPENCODE_CONTEXT_COMPRESSION_ALLOW_DELETE");
  const models = resolveCompactionModelChain(
    modelsOverride ?? readRequiredArray(parsed.compactionModels, "compactionModels"),
    modelsOverride ? RUNTIME_CONFIG_ENV.models : "compactionModels",
  );
  const runtimeLogPath = resolveRuntimePathFromRepoRoot(
    runtimeLogOverride ??
      readRequiredString(parsed.runtimeLogPath, "runtimeLogPath"),
    {
      repoRoot,
      fieldPath: runtimeLogOverride
        ? RUNTIME_CONFIG_ENV.runtimeLogPath
        : "runtimeLogPath",
    },
  );
  const seamLogPath = resolveRuntimePathFromRepoRoot(
    seamLogOverride ??
      readRequiredString(parsed.seamLogPath, "seamLogPath"),
    {
      repoRoot,
      fieldPath: seamLogOverride ? RUNTIME_CONFIG_ENV.seamLogPath : "seamLogPath",
    },
  );
  const debugSnapshotValue = readOptionalEnv(env, RUNTIME_CONFIG_ENV.debugSnapshotPath);

  const prompt = resolvePromptAsset(promptPath, {
    kind: "compaction prompt asset",
    templateMode: "template",
  });

  const reminderPromptPaths = {
    compactOnly: {
      soft: resolveRuntimePathFromRepoRoot(
        readRequiredString(
          parsed.reminder?.promptPaths?.compactOnly?.soft ??
            DEFAULTS.reminder.promptPaths.compactOnly.soft,
          "reminder.promptPaths.compactOnly.soft",
        ),
        { repoRoot, fieldPath: "reminder.promptPaths.compactOnly.soft" },
      ),
      hard: resolveRuntimePathFromRepoRoot(
        readRequiredString(
          parsed.reminder?.promptPaths?.compactOnly?.hard ??
            DEFAULTS.reminder.promptPaths.compactOnly.hard,
          "reminder.promptPaths.compactOnly.hard",
        ),
        { repoRoot, fieldPath: "reminder.promptPaths.compactOnly.hard" },
      ),
    },
    deleteAllowed: {
      soft: resolveRuntimePathFromRepoRoot(
        readRequiredString(
          parsed.reminder?.promptPaths?.deleteAllowed?.soft ??
            DEFAULTS.reminder.promptPaths.deleteAllowed.soft,
          "reminder.promptPaths.deleteAllowed.soft",
        ),
        { repoRoot, fieldPath: "reminder.promptPaths.deleteAllowed.soft" },
      ),
      hard: resolveRuntimePathFromRepoRoot(
        readRequiredString(
          parsed.reminder?.promptPaths?.deleteAllowed?.hard ??
            DEFAULTS.reminder.promptPaths.deleteAllowed.hard,
          "reminder.promptPaths.deleteAllowed.hard",
        ),
        { repoRoot, fieldPath: "reminder.promptPaths.deleteAllowed.hard" },
      ),
    },
  };

  const loggingLevel = resolveLogLevel(
    logLevelOverride ?? parsed.logging?.level ?? DEFAULTS.logging.level,
    logLevelOverride ? RUNTIME_CONFIG_ENV.logLevel : "logging.level",
  );
  const timeoutSeconds = readPositiveInteger(
    timeoutOverride ??
      parsed.compressing?.timeoutSeconds ??
      DEFAULTS.compressing.timeoutSeconds,
    timeoutOverride
      ? RUNTIME_CONFIG_ENV.compressingTimeoutSeconds
      : "compressing.timeoutSeconds",
  );

  const reminderPrompts = {
    compactOnly: {
      soft: resolvePromptAsset(reminderPromptPaths.compactOnly.soft, {
        kind: "Reminder prompt asset 'reminder.promptPaths.compactOnly.soft'",
        templateMode: "plain-text",
      }),
      hard: resolvePromptAsset(reminderPromptPaths.compactOnly.hard, {
        kind: "Reminder prompt asset 'reminder.promptPaths.compactOnly.hard'",
        templateMode: "plain-text",
      }),
    },
    deleteAllowed: {
      soft: resolvePromptAsset(reminderPromptPaths.deleteAllowed.soft, {
        kind: "Reminder prompt asset 'reminder.promptPaths.deleteAllowed.soft'",
        templateMode: "plain-text",
      }),
      hard: resolvePromptAsset(reminderPromptPaths.deleteAllowed.hard, {
        kind: "Reminder prompt asset 'reminder.promptPaths.deleteAllowed.hard'",
        templateMode: "plain-text",
      }),
    },
  };

  const loaded: LoadedRuntimeConfig = {
    repoRoot,
    configPath,
    allowDelete: allowDeleteOverride !== undefined
      ? allowDeleteOverride === "true"
      : readBoolean(
          parsed.allowDelete ?? DEFAULTS.allowDelete,
          "allowDelete",
        ),
    promptPath: prompt.path,
    promptText: prompt.text,
    models,
    markedTokenAutoCompactionThreshold: readPositiveInteger(
      parsed.markedTokenAutoCompactionThreshold ??
        DEFAULTS.markedTokenAutoCompactionThreshold,
      "markedTokenAutoCompactionThreshold",
    ),
    smallUserMessageThreshold: readPositiveInteger(
      parsed.smallUserMessageThreshold ?? DEFAULTS.smallUserMessageThreshold,
      "smallUserMessageThreshold",
    ),
    schedulerMarkThreshold: readPositiveInteger(
      parsed.schedulerMarkThreshold ?? DEFAULTS.schedulerMarkThreshold,
      "schedulerMarkThreshold",
    ),
    runtimeLogPath,
    seamLogPath,
    debugSnapshotPath: debugSnapshotValue
      ? resolveRuntimePathFromRepoRoot(debugSnapshotValue, {
          repoRoot,
          fieldPath: RUNTIME_CONFIG_ENV.debugSnapshotPath,
        })
      : undefined,
    logging: {
      level: loggingLevel,
    },
    compressing: {
      timeoutSeconds,
      timeoutMs: timeoutSeconds * 1_000,
    },
    reminder: {
      hsoft: readPositiveInteger(parsed.reminder?.hsoft ?? DEFAULTS.reminder.hsoft, "reminder.hsoft"),
      hhard: readPositiveInteger(parsed.reminder?.hhard ?? DEFAULTS.reminder.hhard, "reminder.hhard"),
      softRepeatEveryTokens: readPositiveInteger(
        parsed.reminder?.softRepeatEveryTokens ??
          DEFAULTS.reminder.softRepeatEveryTokens,
        "reminder.softRepeatEveryTokens",
      ),
      hardRepeatEveryTokens: readPositiveInteger(
        parsed.reminder?.hardRepeatEveryTokens ??
          DEFAULTS.reminder.hardRepeatEveryTokens,
        "reminder.hardRepeatEveryTokens",
      ),
      promptPaths: reminderPromptPaths,
      prompts: reminderPrompts,
    },
    toast: {
      enabled: readBoolean(
        parsed.toast?.enabled ?? DEFAULTS.toast.enabled,
        "toast.enabled",
      ),
      durations: {
        startup: readPositiveInteger(
          parsed.toast?.durations?.startup ?? DEFAULTS.toast.durations.startup,
          "toast.durations.startup",
        ),
        softReminder: readPositiveInteger(
          parsed.toast?.durations?.softReminder ?? DEFAULTS.toast.durations.softReminder,
          "toast.durations.softReminder",
        ),
        hardReminder: readPositiveInteger(
          parsed.toast?.durations?.hardReminder ?? DEFAULTS.toast.durations.hardReminder,
          "toast.durations.hardReminder",
        ),
        compressionStart: readPositiveInteger(
          parsed.toast?.durations?.compressionStart ?? DEFAULTS.toast.durations.compressionStart,
          "toast.durations.compressionStart",
        ),
        compressionComplete: readPositiveInteger(
          parsed.toast?.durations?.compressionComplete ?? DEFAULTS.toast.durations.compressionComplete,
          "toast.durations.compressionComplete",
        ),
        compressionFailed: readPositiveInteger(
          parsed.toast?.durations?.compressionFailed ?? DEFAULTS.toast.durations.compressionFailed,
          "toast.durations.compressionFailed",
        ),
      },
    },
  };

  return loaded;
}

export function resolveRuntimePathFromRepoRoot(
  configuredPath: string,
  options: {
    readonly repoRoot?: string;
    readonly fieldPath: string;
  },
): string {
  const trimmed = ensureNonEmptyString(configuredPath, options.fieldPath);
  if (trimmed.includes("\u0000")) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${options.fieldPath} must not contain NUL bytes.`,
    );
  }

  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }

  return resolve(options.repoRoot ?? resolveRuntimeConfigRepoRoot(), trimmed);
}

export function resolveCompactionModelChain(
  source: string | readonly unknown[],
  fieldPath: string,
): readonly string[] {
  const values =
    typeof source === "string"
      ? source
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : source.map((entry) => ensureNonEmptyString(entry, `${fieldPath}[]`));

  if (values.length === 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${fieldPath} must contain at least one model name.`,
    );
  }

  return Object.freeze([...values]);
}

export function resolvePromptAsset(
  assetPath: string,
  options: {
    readonly kind: string;
    readonly templateMode: "template" | "plain-text";
  },
): LoadedPromptAsset {
  if (!existsSync(assetPath)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Missing prompt asset '${assetPath}' for ${options.kind}.`,
    );
  }

  const text = readFileSync(assetPath, "utf8");
  if (text.trim().length === 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${options.kind} at '${assetPath}' must contain non-empty prompt text.`,
    );
  }

  if (
    options.templateMode === "plain-text" &&
    TEMPLATE_PLACEHOLDER_PATTERN.test(text)
  ) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${options.kind} at '${assetPath}' must be plain text and must not contain template placeholders.`,
    );
  }

  return Object.freeze({
    path: assetPath,
    text,
  });
}

export function resolveReminderPrompt(
  config: LoadedRuntimeConfig,
  options: {
    readonly severity: ReminderSeverity;
    readonly allowDelete: boolean;
  },
): LoadedPromptAsset {
  return options.allowDelete
    ? config.reminder.prompts.deleteAllowed[options.severity]
    : config.reminder.prompts.compactOnly[options.severity];
}

export function readReminderThresholds(
  config: LoadedRuntimeConfig,
): RuntimeConfigReminderThresholds {
  return Object.freeze({
    hsoft: config.reminder.hsoft,
    hhard: config.reminder.hhard,
    softRepeatEveryTokens: config.reminder.softRepeatEveryTokens,
    hardRepeatEveryTokens: config.reminder.hardRepeatEveryTokens,
  });
}

export function readCompactionThresholds(
  config: LoadedRuntimeConfig,
): RuntimeConfigCompactionThresholds {
  return Object.freeze({
    markedTokenAutoCompactionThreshold:
      config.markedTokenAutoCompactionThreshold,
    schedulerMarkThreshold: config.schedulerMarkThreshold,
    smallUserMessageThreshold: config.smallUserMessageThreshold,
  });
}

function resolveConfigFilePath(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): string {
  const override = readOptionalEnv(env, RUNTIME_CONFIG_ENV.configPath);
  const configPath = override
    ? (isAbsolute(override) ? resolve(override) : resolve(repoRoot, override))
    : resolve(repoRoot, DEFAULT_RUNTIME_CONFIG_PATH);

  if (!existsSync(configPath)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Missing runtime config file '${configPath}'.`,
    );
  }

  return configPath;
}

function parseRuntimeConfigFile(configPath: string): RuntimeConfigInput {
  const source = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseJsonc(source);
  } catch (err) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Invalid JSONC in runtime config '${configPath}': ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config '${configPath}' must be a JSON object.`,
    );
  }

  validateRootShape(parsed);

  if (parsed.version !== 1) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config field 'version' must equal 1.`,
    );
  }

  return parsed as RuntimeConfigInput;
}

function validateRootShape(config: Record<string, unknown>): void {
  assertAllowedKeys(config, ALLOWED_ROOT_KEYS, "root");

  if ("logging" in config) {
    assertNestedObject(config.logging, "logging");
    assertAllowedKeys(config.logging as Record<string, unknown>, ALLOWED_LOGGING_KEYS, "logging");
  }

  if ("compressing" in config) {
    assertNestedObject(config.compressing, "compressing");
    assertAllowedKeys(
      config.compressing as Record<string, unknown>,
      ALLOWED_COMPRESSING_KEYS,
      "compressing",
    );
  }

  if ("reminder" in config) {
    assertNestedObject(config.reminder, "reminder");
    const reminder = config.reminder as Record<string, unknown>;
    assertAllowedKeys(reminder, ALLOWED_REMINDER_KEYS, "reminder");

    if ("promptPaths" in reminder) {
      assertNestedObject(reminder.promptPaths, "reminder.promptPaths");
      const promptPaths = reminder.promptPaths as Record<string, unknown>;
      assertAllowedKeys(
        promptPaths,
        ALLOWED_REMINDER_PROMPT_KEYS,
        "reminder.promptPaths",
      );

      for (const branch of ["compactOnly", "deleteAllowed"] as const) {
        if (branch in promptPaths) {
          assertNestedObject(
            promptPaths[branch],
            `reminder.promptPaths.${branch}`,
          );
          assertAllowedKeys(
            promptPaths[branch] as Record<string, unknown>,
            ALLOWED_REMINDER_VARIANT_KEYS,
            `reminder.promptPaths.${branch}`,
          );
        }
      }
    }
  }

  if ("toast" in config) {
    assertNestedObject(config.toast, "toast");
    const toast = config.toast as Record<string, unknown>;
    assertAllowedKeys(toast, ALLOWED_TOAST_KEYS, "toast");

    if ("durations" in toast) {
      assertNestedObject(toast.durations, "toast.durations");
      assertAllowedKeys(
        toast.durations as Record<string, unknown>,
        ALLOWED_TOAST_DURATION_KEYS,
        "toast.durations",
      );
    }
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  fieldPath: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new OpencodeContextCompressionRuntimeConfigError(
        `Runtime config field '${fieldPath}' contains unsupported property '${key}'.`,
      );
    }
  }
}

function assertNestedObject(value: unknown, fieldPath: string): void {
  if (!isRecord(value)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `Runtime config field '${fieldPath}' must be an object.`,
    );
  }
}

function resolveLogLevel(value: unknown, fieldPath: string): RuntimeLogLevel {
  const normalized = ensureNonEmptyString(value, fieldPath);
  if (!LOG_LEVELS.includes(normalized as RuntimeLogLevel)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${fieldPath} field '${fieldPath}' must be one of: ${LOG_LEVELS.join(", ")}.`,
    );
  }
  return normalized as RuntimeLogLevel;
}

function readPositiveInteger(value: unknown, fieldPath: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${fieldPath} must be a positive integer.`,
    );
  }

  return parsed;
}

function readBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== "boolean") {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${fieldPath} must be a boolean.`,
    );
  }

  return value;
}

function readRequiredString(value: unknown, fieldPath: string): string {
  return ensureNonEmptyString(value, fieldPath);
}

function readRequiredArray(value: unknown, fieldPath: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${fieldPath} must be an array.`,
    );
  }

  return value;
}

function ensureNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string") {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${fieldPath} must be a non-empty string.`,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${fieldPath} must be a non-empty string.`,
    );
  }

  return trimmed;
}

function readOptionalEnv(
  env: NodeJS.ProcessEnv,
  envName: string,
): string | undefined {
  const value = env[envName];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new OpencodeContextCompressionRuntimeConfigError(
      `${envName} is set but empty.`,
    );
  }

  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
