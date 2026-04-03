import type { Hooks } from "@opencode-ai/plugin";

import {
  DEFAULT_LOCK_POLL_INTERVAL_MS,
  readSessionFileLock,
  resolvePluginLockDirectory,
  type RunningSessionFileLockRecord,
} from "./file-lock.js";
import { createSqliteSessionStateStore } from "../state/store.js";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ToolExecuteBeforeHook = NonNullable<Hooks["tool.execute.before"]>;

const DEFAULT_MARK_TOOL_NAMES = Object.freeze(["compression_mark"]);
const DEFAULT_BLOCKED_INTERNAL_TOOL_NAMES = Object.freeze(["compression_run_internal"]);

export interface SendEntryGateSharedOptions {
  readonly pluginDirectory: string;
  readonly lockDirectory?: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface WaitForOrdinaryChatGateOptions extends SendEntryGateSharedOptions {
  readonly sessionID: string;
}

export interface GuardToolExecutionDuringLockOptions extends SendEntryGateSharedOptions {
  readonly sessionID: string;
  readonly toolName: string;
  readonly markToolNames?: readonly string[];
  readonly blockedInternalToolNames?: readonly string[];
}

export interface CreateSendEntryGateHooksOptions extends SendEntryGateSharedOptions {
  readonly markToolNames?: readonly string[];
  readonly blockedInternalToolNames?: readonly string[];
}

export type OrdinaryChatGateWaitOutcome =
  | {
      readonly outcome: "succeeded";
      readonly source: "lock-file" | "compaction-batch";
    }
  | {
      readonly outcome: "failed";
      readonly source: "lock-file" | "compaction-batch";
    }
  | {
      readonly outcome: "timed-out";
      readonly source: "lock-file";
    }
  | {
      readonly outcome: "manually-cleared";
      readonly source: "lock-file";
      readonly lastObservedLock: RunningSessionFileLockRecord;
      readonly batchStatus?: "frozen" | "running";
    };

export class ActiveCompactionLockError extends Error {
  readonly sessionID: string;
  readonly toolName: string;

  constructor(sessionID: string, toolName: string) {
    super(`Cannot run internal compaction tool '${toolName}' while compaction is active for session '${sessionID}'.`);
    this.name = "ActiveCompactionLockError";
    this.sessionID = sessionID;
    this.toolName = toolName;
  }
}

export function createSendEntryGateHooks(
  options: CreateSendEntryGateHooksOptions,
): Pick<Hooks, "chat.message" | "tool.execute.before"> {
  const chatMessage: ChatMessageHook = async (input) => {
    await waitForOrdinaryChatGateIfNeeded({
      pluginDirectory: options.pluginDirectory,
      lockDirectory: options.lockDirectory,
      sessionID: input.sessionID,
      now: options.now,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      sleep: options.sleep,
    });
  };

  const toolExecuteBefore: ToolExecuteBeforeHook = async (input) => {
    await guardToolExecutionDuringLock({
      pluginDirectory: options.pluginDirectory,
      lockDirectory: options.lockDirectory,
      sessionID: input.sessionID,
      toolName: input.tool,
      markToolNames: options.markToolNames,
      blockedInternalToolNames: options.blockedInternalToolNames,
      now: options.now,
      timeoutMs: options.timeoutMs,
    });
  };

  return {
    "chat.message": chatMessage,
    "tool.execute.before": toolExecuteBefore,
  };
}

export async function waitForOrdinaryChatGateIfNeeded(
  options: WaitForOrdinaryChatGateOptions,
): Promise<OrdinaryChatGateWaitOutcome | undefined> {
  const lockDirectory = options.lockDirectory ?? resolvePluginLockDirectory(options.pluginDirectory);
  const lockState = await readSessionFileLock({
    lockDirectory,
    sessionID: options.sessionID,
    now: options.now,
    timeoutMs: options.timeoutMs,
  });

  switch (lockState.kind) {
    case "running":
      return waitForOrdinaryChatGate({
        ...options,
        lockDirectory,
        initialLock: lockState.record,
      });
    case "stale":
      return {
        outcome: "timed-out",
        source: "lock-file",
      };
    case "succeeded":
      return {
        outcome: "succeeded",
        source: "lock-file",
      };
    case "failed":
      return {
        outcome: "failed",
        source: "lock-file",
      };
    case "unlocked":
      return undefined;
  }
}

export async function guardToolExecutionDuringLock(
  options: GuardToolExecutionDuringLockOptions,
): Promise<void> {
  const markToolNames = normalizeToolNames(options.markToolNames, DEFAULT_MARK_TOOL_NAMES);
  if (markToolNames.has(options.toolName)) {
    return;
  }

  const lockDirectory = options.lockDirectory ?? resolvePluginLockDirectory(options.pluginDirectory);
  const lockState = await readSessionFileLock({
    lockDirectory,
    sessionID: options.sessionID,
    now: options.now,
    timeoutMs: options.timeoutMs,
  });

  if (lockState.kind !== "running") {
    return;
  }

  const blockedInternalToolNames = normalizeToolNames(
    options.blockedInternalToolNames,
    DEFAULT_BLOCKED_INTERNAL_TOOL_NAMES,
  );
  if (blockedInternalToolNames.has(options.toolName)) {
    throw new ActiveCompactionLockError(options.sessionID, options.toolName);
  }
}

async function waitForOrdinaryChatGate(
  options: WaitForOrdinaryChatGateOptions & {
    readonly lockDirectory: string;
    readonly initialLock: RunningSessionFileLockRecord;
  },
): Promise<OrdinaryChatGateWaitOutcome> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const store = createSqliteSessionStateStore({
    pluginDirectory: options.pluginDirectory,
    sessionID: options.sessionID,
    now: options.now,
  });

  try {
    let lastObservedLock = options.initialLock;

    while (true) {
      const lockState = await readSessionFileLock({
        lockDirectory: options.lockDirectory,
        sessionID: options.sessionID,
        now: options.now,
        timeoutMs: options.timeoutMs,
      });

      switch (lockState.kind) {
        case "running":
          lastObservedLock = lockState.record;
          await sleep(pollIntervalMs);
          continue;
        case "stale":
          return {
            outcome: "timed-out",
            source: "lock-file",
          };
        case "succeeded":
          return {
            outcome: "succeeded",
            source: "lock-file",
          };
        case "failed":
          return {
            outcome: "failed",
            source: "lock-file",
          };
        case "unlocked":
          return resolveUnlockedOutcome(store, lastObservedLock);
      }
    }
  } finally {
    store.close();
  }
}

function resolveUnlockedOutcome(
  store: ReturnType<typeof createSqliteSessionStateStore>,
  lastObservedLock: RunningSessionFileLockRecord,
): OrdinaryChatGateWaitOutcome {
  const batch = store.findCompactionBatchByFrozenAtMs(lastObservedLock.startedAtMs);
  if (batch === undefined) {
    return {
      outcome: "manually-cleared",
      source: "lock-file",
      lastObservedLock,
    };
  }

  switch (batch.status) {
    case "succeeded":
      return {
        outcome: "succeeded",
        source: "compaction-batch",
      };
    case "failed":
    case "cancelled":
      return {
        outcome: "failed",
        source: "compaction-batch",
      };
    case "frozen":
    case "running":
      return {
        outcome: "manually-cleared",
        source: "lock-file",
        lastObservedLock,
        batchStatus: batch.status,
      };
  }
}

function normalizeToolNames(input: readonly string[] | undefined, fallback: readonly string[]): ReadonlySet<string> {
  return new Set((input ?? fallback).map((name) => name.trim()).filter((name) => name.length > 0));
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
