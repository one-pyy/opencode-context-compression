import {
  acquireSessionFileLock,
  readSessionFileLock,
  type AcquireSessionFileLockOptions,
  type AcquireSessionFileLockResult,
  type RunningSessionFileLockState,
  type SessionFileLockState,
  type SessionFileLockWaitOutcome,
  type WaitForSessionFileLockOptions,
  waitForSessionFileLock,
} from "./file-lock.js";
import { freezeBatch, type FrozenBatch } from "./frozen-batch.js";

export type LockGatePath = "ordinary-chat" | "dcp-mark-tool" | "non-dcp-tool";

export type LockGateTarget =
  | {
      readonly kind: "ordinary-chat";
    }
  | {
      readonly kind: "tool";
      readonly toolName: string;
      readonly dcpMarkToolName: string;
    };

export type LockGateDecision =
  | {
      readonly path: "ordinary-chat";
      readonly action: "wait";
      readonly reason: "active-compaction-lock";
      readonly lockState: RunningSessionFileLockState;
      wait(): Promise<SessionFileLockWaitOutcome>;
    }
  | {
      readonly path: LockGatePath;
      readonly action: "allow";
      readonly reason:
        | "gate-open"
        | "stale-lock-ignored"
        | "dcp-mark-tool-bypasses-active-lock"
        | "non-dcp-tool-bypasses-lock";
      readonly lockState: SessionFileLockState;
    };

export interface EvaluateLockGateOptions extends WaitForSessionFileLockOptions {
  readonly target: LockGateTarget;
}

export interface StartFrozenCompactionBatchOptions<T> extends AcquireSessionFileLockOptions {
  readonly marks: readonly T[];
  readonly identifyMark: (mark: T) => string;
}

export type StartFrozenCompactionBatchResult<T> =
  | {
      readonly started: true;
      readonly batch: FrozenBatch<T>;
      readonly lockPath: string;
      readonly lock: Extract<AcquireSessionFileLockResult, { acquired: true }>["record"];
    }
  | {
      readonly started: false;
      readonly lockPath: string;
      readonly state: Extract<AcquireSessionFileLockResult, { acquired: false }>["state"];
    };

export function classifyLockGatePath(target: LockGateTarget): LockGatePath {
  if (target.kind === "ordinary-chat") {
    return "ordinary-chat";
  }

  return target.toolName === target.dcpMarkToolName ? "dcp-mark-tool" : "non-dcp-tool";
}

export async function evaluateLockGate(options: EvaluateLockGateOptions): Promise<LockGateDecision> {
  const path = classifyLockGatePath(options.target);
  const lockState = await readSessionFileLock(options);

  if (lockState.kind === "running") {
    if (path === "ordinary-chat") {
      return {
        path,
        action: "wait",
        reason: "active-compaction-lock",
        lockState,
        wait: () => waitForSessionFileLock(options),
      };
    }

    return {
      path,
      action: "allow",
      reason: path === "dcp-mark-tool" ? "dcp-mark-tool-bypasses-active-lock" : "non-dcp-tool-bypasses-lock",
      lockState,
    };
  }

  return {
    path,
    action: "allow",
    reason: lockState.kind === "stale" ? "stale-lock-ignored" : "gate-open",
    lockState,
  };
}

export async function startFrozenCompactionBatch<T>(
  options: StartFrozenCompactionBatchOptions<T>,
): Promise<StartFrozenCompactionBatchResult<T>> {
  const now = options.now ?? Date.now;

  const batch = freezeBatch(options.marks, options.identifyMark, now);
  const lockResult = await acquireSessionFileLock({
    lockDirectory: options.lockDirectory,
    sessionID: options.sessionID,
    timeoutMs: options.timeoutMs,
    now,
    startedAtMs: batch.frozenAtMs,
    note: options.note,
  });

  if (!lockResult.acquired) {
    return {
      started: false,
      lockPath: lockResult.lockPath,
      state: lockResult.state,
    };
  }

  return {
    started: true,
    batch,
    lockPath: lockResult.lockPath,
    lock: lockResult.record,
  };
}
