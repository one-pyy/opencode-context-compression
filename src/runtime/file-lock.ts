import { mkdir, open, readFile, readdir, rmdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  assertSafeSessionIDSegment,
  resolvePathWithinDirectory,
} from "./path-safety.js";

export const DEFAULT_LOCK_DIRECTORY_NAME = "locks";
export const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 25;
const TRANSIENT_LOCK_READ_RETRY_COUNT = 5;
const TRANSIENT_LOCK_READ_RETRY_DELAY_MS = 2;

const SESSION_FILE_LOCK_VERSION = 1 as const;

export type SessionFileLockStatus = "running" | "succeeded" | "failed";

interface SessionFileLockRecordBase {
  readonly version: typeof SESSION_FILE_LOCK_VERSION;
  readonly sessionID: string;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly settledAtMs?: number;
  readonly note?: string;
}

export interface RunningSessionFileLockRecord extends SessionFileLockRecordBase {
  readonly status: "running";
}

export interface SucceededSessionFileLockRecord extends SessionFileLockRecordBase {
  readonly status: "succeeded";
}

export interface FailedSessionFileLockRecord extends SessionFileLockRecordBase {
  readonly status: "failed";
}

export type SessionFileLockRecord =
  | RunningSessionFileLockRecord
  | SucceededSessionFileLockRecord
  | FailedSessionFileLockRecord;

type BaseSessionFileLockState = {
  readonly lockPath: string;
  readonly sessionID: string;
};

export type UnlockedSessionFileLockState = BaseSessionFileLockState & {
  readonly kind: "unlocked";
};

export type RunningSessionFileLockState = BaseSessionFileLockState & {
  readonly kind: "running";
  readonly ageMs: number;
  readonly record: RunningSessionFileLockRecord;
};

export type StaleSessionFileLockState = BaseSessionFileLockState & {
  readonly kind: "stale";
  readonly ageMs: number;
  readonly record: RunningSessionFileLockRecord;
};

export type SucceededSessionFileLockState = BaseSessionFileLockState & {
  readonly kind: "succeeded";
  readonly ageMs: number;
  readonly record: SucceededSessionFileLockRecord;
};

export type FailedSessionFileLockState = BaseSessionFileLockState & {
  readonly kind: "failed";
  readonly ageMs: number;
  readonly record: FailedSessionFileLockRecord;
};

export type SessionFileLockState =
  | UnlockedSessionFileLockState
  | RunningSessionFileLockState
  | StaleSessionFileLockState
  | SucceededSessionFileLockState
  | FailedSessionFileLockState;

export type SessionFileLockWaitOutcome =
  | {
      readonly outcome: "unlocked";
      readonly finalState: UnlockedSessionFileLockState;
    }
  | {
      readonly outcome: "succeeded";
      readonly finalState: SucceededSessionFileLockState;
    }
  | {
      readonly outcome: "failed";
      readonly finalState: FailedSessionFileLockState;
    }
  | {
      readonly outcome: "timed-out";
      readonly finalState: StaleSessionFileLockState;
    }
  | {
      readonly outcome: "manually-cleared";
      readonly finalState: UnlockedSessionFileLockState;
      readonly lastObservedLock: RunningSessionFileLockRecord;
    };

export interface SessionFileLockOptions {
  readonly lockDirectory: string;
  readonly sessionID: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly pruneEmptyLockDirectory?: boolean;
}

export interface AcquireSessionFileLockOptions extends SessionFileLockOptions {
  readonly startedAtMs?: number;
  readonly note?: string;
}

export interface SettleSessionFileLockOptions extends SessionFileLockOptions {
  readonly status: Extract<SessionFileLockStatus, "succeeded" | "failed">;
  readonly settledAtMs?: number;
  readonly note?: string;
}

export interface WaitForSessionFileLockOptions extends SessionFileLockOptions {
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SettleAndReleaseSessionFileLockOptions
  extends SettleSessionFileLockOptions {}

export type AcquireSessionFileLockResult =
  | {
      readonly acquired: true;
      readonly lockPath: string;
      readonly record: SessionFileLockRecord;
    }
  | {
      readonly acquired: false;
      readonly lockPath: string;
      readonly state: RunningSessionFileLockState;
    };

export function resolvePluginLockDirectory(
  pluginDirectory: string,
  lockDirectoryName = DEFAULT_LOCK_DIRECTORY_NAME,
): string {
  return join(pluginDirectory, lockDirectoryName);
}

export function resolveSessionFileLockPath(
  lockDirectory: string,
  sessionID: string,
): string {
  const safeSessionID = assertSafeSessionIDSegment(sessionID);
  return resolvePathWithinDirectory(
    lockDirectory,
    `${safeSessionID}.lock`,
    "session lock",
  );
}

export async function acquireSessionFileLock(
  options: AcquireSessionFileLockOptions,
): Promise<AcquireSessionFileLockResult> {
  const lockPath = resolveSessionFileLockPath(
    options.lockDirectory,
    options.sessionID,
  );
  const now = options.now ?? Date.now;
  const startedAtMs = options.startedAtMs ?? now();
  const record: RunningSessionFileLockRecord = {
    version: SESSION_FILE_LOCK_VERSION,
    sessionID: options.sessionID,
    status: "running",
    startedAtMs,
    updatedAtMs: startedAtMs,
    ...(options.note ? { note: options.note } : {}),
  };

  await mkdir(options.lockDirectory, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readSessionFileLock({
      ...options,
      pruneEmptyLockDirectory: false,
    });
    if (current.kind === "running") {
      return {
        acquired: false,
        lockPath,
        state: current,
      };
    }

    if (current.kind !== "unlocked") {
      await rm(lockPath, { force: true });
    }

    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(serializeSessionFileLockRecord(record), "utf8");
      } finally {
        await handle.close();
      }

      return {
        acquired: true,
        lockPath,
        record,
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  const finalState = await readSessionFileLock({
    ...options,
    pruneEmptyLockDirectory: false,
  });
  if (finalState.kind === "running") {
    return {
      acquired: false,
      lockPath,
      state: finalState,
    };
  }

  throw new Error(
    `Failed to acquire lock for session '${options.sessionID}' at '${lockPath}'.`,
  );
}

export async function readSessionFileLock(
  options: SessionFileLockOptions,
): Promise<SessionFileLockState> {
  const lockPath = resolveSessionFileLockPath(
    options.lockDirectory,
    options.sessionID,
  );

  for (
    let attempt = 0;
    attempt <= TRANSIENT_LOCK_READ_RETRY_COUNT;
    attempt += 1
  ) {
    let serialized: string;
    try {
      serialized = await readFile(lockPath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        if (options.pruneEmptyLockDirectory ?? true) {
          await removeLockDirectoryIfEmpty(options.lockDirectory);
        }
        return {
          kind: "unlocked",
          lockPath,
          sessionID: options.sessionID,
        };
      }

      throw error;
    }

    try {
      return classifySessionFileLockState({
        lockPath,
        sessionID: options.sessionID,
        timeoutMs: options.timeoutMs,
        now: options.now,
        serialized,
      });
    } catch (error) {
      if (
        attempt < TRANSIENT_LOCK_READ_RETRY_COUNT &&
        isTransientLockReadError(error, serialized)
      ) {
        await defaultSleep(TRANSIENT_LOCK_READ_RETRY_DELAY_MS);
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    `Failed to read lock for session '${options.sessionID}' at '${lockPath}'.`,
  );
}

export async function settleSessionFileLock(
  options: SettleSessionFileLockOptions,
): Promise<SessionFileLockRecord | undefined> {
  const state = await readSessionFileLock(options);
  if (state.kind === "unlocked") {
    return undefined;
  }

  const lockPath = resolveSessionFileLockPath(
    options.lockDirectory,
    options.sessionID,
  );
  const settledAtMs = options.settledAtMs ?? (options.now ?? Date.now)();
  const record: SessionFileLockRecord = {
    ...state.record,
    status: options.status,
    updatedAtMs: settledAtMs,
    settledAtMs,
    ...(options.note
      ? { note: options.note }
      : state.record.note
        ? { note: state.record.note }
        : {}),
  };

  try {
    const handle = await open(lockPath, "r+");
    try {
      await handle.truncate(0);
      await handle.writeFile(serializeSessionFileLockRecord(record), "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }

  return record;
}

export async function releaseSessionFileLock(
  options: SessionFileLockOptions,
): Promise<void> {
  const lockPath = resolveSessionFileLockPath(
    options.lockDirectory,
    options.sessionID,
  );
  await rm(lockPath, { force: true });
  await removeLockDirectoryIfEmpty(options.lockDirectory);
}

export async function settleAndReleaseSessionFileLock(
  options: SettleAndReleaseSessionFileLockOptions,
): Promise<SessionFileLockRecord | undefined> {
  const record = await settleSessionFileLock(options);
  await releaseSessionFileLock(options);
  return record;
}

export async function waitForSessionFileLock(
  options: WaitForSessionFileLockOptions,
): Promise<SessionFileLockWaitOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS;
  let lastObservedLock: RunningSessionFileLockRecord | undefined;

  while (true) {
    const state = await readSessionFileLock(options);
    switch (state.kind) {
      case "unlocked":
        if (lastObservedLock) {
          return {
            outcome: "manually-cleared",
            finalState: state,
            lastObservedLock,
          };
        }

        return {
          outcome: "unlocked",
          finalState: state,
        };
      case "succeeded":
        return {
          outcome: "succeeded",
          finalState: state,
        };
      case "failed":
        return {
          outcome: "failed",
          finalState: state,
        };
      case "stale":
        return {
          outcome: "timed-out",
          finalState: state,
        };
      case "running":
        lastObservedLock = state.record;
        await sleep(pollIntervalMs);
        break;
    }
  }
}

function serializeSessionFileLockRecord(record: SessionFileLockRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function classifySessionFileLockState(options: {
  readonly lockPath: string;
  readonly sessionID: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly serialized: string;
}): SessionFileLockState {
  const record = parseSessionFileLockRecord(
    options.serialized,
    options.sessionID,
    options.lockPath,
  );
  const ageMs = Math.max(0, (options.now ?? Date.now)() - record.startedAtMs);

  if (
    record.status === "running" &&
    ageMs > (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  ) {
    return {
      kind: "stale",
      lockPath: options.lockPath,
      sessionID: options.sessionID,
      ageMs,
      record,
    };
  }

  switch (record.status) {
    case "running":
      return {
        kind: "running",
        lockPath: options.lockPath,
        sessionID: options.sessionID,
        ageMs,
        record,
      };
    case "succeeded":
      return {
        kind: "succeeded",
        lockPath: options.lockPath,
        sessionID: options.sessionID,
        ageMs,
        record,
      };
    case "failed":
      return {
        kind: "failed",
        lockPath: options.lockPath,
        sessionID: options.sessionID,
        ageMs,
        record,
      };
  }
}

function parseSessionFileLockRecord(
  serialized: string,
  sessionID: string,
  lockPath: string,
): SessionFileLockRecord {
  const candidate = JSON.parse(serialized) as Record<string, unknown>;
  const parsedSessionID = expectString(
    candidate.sessionID,
    "sessionID",
    lockPath,
  );
  if (parsedSessionID !== sessionID) {
    throw new Error(
      `Lock file '${lockPath}' belongs to session '${parsedSessionID}', not requested session '${sessionID}'.`,
    );
  }

  const status = expectStatus(candidate.status, lockPath);

  const baseRecord = {
    version: expectVersion(candidate.version, lockPath),
    sessionID: parsedSessionID,
    startedAtMs: expectNumber(candidate.startedAtMs, "startedAtMs", lockPath),
    updatedAtMs: expectNumber(candidate.updatedAtMs, "updatedAtMs", lockPath),
    ...(candidate.settledAtMs === undefined
      ? {}
      : {
          settledAtMs: expectNumber(
            candidate.settledAtMs,
            "settledAtMs",
            lockPath,
          ),
        }),
    ...(candidate.note === undefined
      ? {}
      : { note: expectString(candidate.note, "note", lockPath) }),
  } satisfies SessionFileLockRecordBase;

  switch (status) {
    case "running":
      return {
        ...baseRecord,
        status,
      };
    case "succeeded":
      return {
        ...baseRecord,
        status,
      };
    case "failed":
      return {
        ...baseRecord,
        status,
      };
  }
}

function expectVersion(
  value: unknown,
  lockPath: string,
): typeof SESSION_FILE_LOCK_VERSION {
  if (value !== SESSION_FILE_LOCK_VERSION) {
    throw new Error(
      `Lock file '${lockPath}' has unsupported version '${String(value)}'.`,
    );
  }

  return SESSION_FILE_LOCK_VERSION;
}

function expectStatus(value: unknown, lockPath: string): SessionFileLockStatus {
  if (value === "running" || value === "succeeded" || value === "failed") {
    return value;
  }

  throw new Error(
    `Lock file '${lockPath}' has unsupported status '${String(value)}'.`,
  );
}

function expectString(
  value: unknown,
  fieldName: string,
  lockPath: string,
): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(
    `Lock file '${lockPath}' is missing a non-empty string '${fieldName}'.`,
  );
}

function expectNumber(
  value: unknown,
  fieldName: string,
  lockPath: string,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new Error(
    `Lock file '${lockPath}' is missing a finite numeric '${fieldName}'.`,
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return readNodeErrorCode(error) === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return readNodeErrorCode(error) === "ENOENT";
}

async function removeLockDirectoryIfEmpty(lockDirectory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(lockDirectory);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    throw error;
  }

  if (entries.length > 0) {
    return;
  }

  try {
    await rmdir(lockDirectory);
  } catch (error) {
    if (isNotFoundError(error) || readNodeErrorCode(error) === "ENOTEMPTY") {
      return;
    }

    throw error;
  }
}

function isTransientLockReadError(error: unknown, serialized: string): boolean {
  const trimmed = serialized.trim();
  if (trimmed.length === 0) {
    return true;
  }

  if (isUnexpectedEndOfJsonError(error)) {
    return true;
  }

  return !serialized.trimEnd().endsWith("}");
}

function readNodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isUnexpectedEndOfJsonError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) {
    return false;
  }

  return error.message.includes("Unexpected end of JSON input");
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
