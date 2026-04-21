import { isAbsolute, resolve } from "node:path";

import { resolveRuntimeConfigRepoRoot } from "../config/runtime-config.js";

import {
  DEFAULT_LOCK_DIRECTORY_NAME,
  resolvePluginLockDirectory,
  resolveSessionFileLockPath,
} from "./file-lock.js";
import {
  assertSafeSessionIDSegment,
  resolvePathWithinDirectory,
} from "./path-safety.js";

export const DEFAULT_STATE_DIRECTORY_NAME = "state";
export const DEFAULT_DEBUG_SNAPSHOT_HOOK_INPUT_SUFFIX = ".hook-in.json";
export const DEFAULT_DEBUG_SNAPSHOT_PROJECTION_INPUT_SUFFIX = ".projection-in.json";
export const DEFAULT_DEBUG_SNAPSHOT_OUTPUT_SUFFIX = ".out.json";

export interface SessionSidecarLayoutOptions {
  readonly pluginDirectory: string;
  readonly sessionID: string;
  readonly runtimeLogPath: string;
  readonly seamLogPath: string;
  readonly debugSnapshotPath?: string;
  readonly stateDirectoryName?: string;
  readonly lockDirectoryName?: string;
}

export interface SessionSidecarLayout {
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly lockDirectory: string;
  readonly lockPath: string;
  readonly runtimeLogPath: string;
  readonly seamLogPath: string;
  readonly debugSnapshotDirectory?: string;
  readonly debugSnapshotHookInputPath?: string;
  readonly debugSnapshotProjectionInputPath?: string;
  readonly debugSnapshotOutputPath?: string;
}

export function resolveSessionSidecarLayout(
  options: SessionSidecarLayoutOptions,
): SessionSidecarLayout {
  const stateDirectory = resolvePluginStateDirectory(
    options.pluginDirectory,
    options.stateDirectoryName,
  );
  const lockDirectory = resolvePluginLockDirectory(
    options.pluginDirectory,
    options.lockDirectoryName ?? DEFAULT_LOCK_DIRECTORY_NAME,
  );
  const databasePath = resolveSessionDatabasePath(
    stateDirectory,
    options.sessionID,
  );
  const lockPath = resolveSessionFileLockPath(lockDirectory, options.sessionID);
  const runtimeLogPath = resolveRepoOwnedArtifactPath(
    options.pluginDirectory,
    options.runtimeLogPath,
  );
  const seamLogPath = resolveRepoOwnedArtifactPath(
    options.pluginDirectory,
    options.seamLogPath,
  );

  if (!options.debugSnapshotPath) {
    return {
      stateDirectory,
      databasePath,
      lockDirectory,
      lockPath,
      runtimeLogPath,
      seamLogPath,
    };
  }

  const debugSnapshotDirectory = resolveRepoOwnedArtifactPath(
    options.pluginDirectory,
    options.debugSnapshotPath,
  );
  const debugSnapshotHookInputPath = resolveSessionDebugSnapshotPath(
    debugSnapshotDirectory,
    options.sessionID,
    "hook-in",
  );
  const debugSnapshotProjectionInputPath = resolveSessionDebugSnapshotPath(
    debugSnapshotDirectory,
    options.sessionID,
    "projection-in",
  );
  const debugSnapshotOutputPath = resolveSessionDebugSnapshotPath(
    debugSnapshotDirectory,
    options.sessionID,
    "out",
  );

  return {
    stateDirectory,
    databasePath,
    lockDirectory,
    lockPath,
    runtimeLogPath,
    seamLogPath,
    debugSnapshotDirectory,
    debugSnapshotHookInputPath,
    debugSnapshotProjectionInputPath,
    debugSnapshotOutputPath,
  };
}

export function resolvePluginStateDirectory(
  _pluginDirectory: string,
  stateDirectoryName = DEFAULT_STATE_DIRECTORY_NAME,
): string {
  return resolve(resolveRuntimeConfigRepoRoot(), stateDirectoryName);
}

export function resolveSessionDatabasePath(
  stateDirectory: string,
  sessionID: string,
): string {
  const safeSessionID = assertSafeSessionIDSegment(sessionID);
  return resolvePathWithinDirectory(
    stateDirectory,
    `${safeSessionID}.db`,
    "session database",
  );
}

export function resolveRepoOwnedArtifactPath(
  pluginDirectory: string,
  configuredPath: string,
): string {
  return isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(pluginDirectory, configuredPath);
}

export function resolveSessionDebugSnapshotPath(
  snapshotDirectory: string,
  sessionID: string,
  phase: "hook-in" | "projection-in" | "out",
): string {
  const safeSessionID = assertSafeSessionIDSegment(sessionID);
  const suffix =
    phase === "hook-in"
      ? DEFAULT_DEBUG_SNAPSHOT_HOOK_INPUT_SUFFIX
      : phase === "projection-in"
        ? DEFAULT_DEBUG_SNAPSHOT_PROJECTION_INPUT_SUFFIX
        : DEFAULT_DEBUG_SNAPSHOT_OUTPUT_SUFFIX;
  return resolvePathWithinDirectory(
    snapshotDirectory,
    `${safeSessionID}${suffix}`,
    `debug snapshot ${phase}`,
  );
}
