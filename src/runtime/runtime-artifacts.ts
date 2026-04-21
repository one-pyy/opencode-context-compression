import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { RuntimeLogLevel } from "../config/runtime-config.js";
import { resolveSessionSidecarLayout } from "./sidecar-layout.js";

export interface RuntimeEventRecord {
  readonly createdAt: string;
  readonly sessionID: string;
  readonly seam:
    | "experimental.chat.messages.transform"
    | "chat.params"
    | "tool.execute.before";
  readonly stage: string;
  readonly payload: unknown;
}

export type RuntimeDiagnosticSeverity = "error" | "info" | "debug";

export interface RuntimeDiagnosticRecord {
  readonly createdAt: string;
  readonly sessionID: string;
  readonly scope: string;
  readonly severity: RuntimeDiagnosticSeverity;
  readonly message: string;
  readonly payload?: unknown;
}

export interface RuntimeArtifactRecorder {
  recordEvent(input: {
    readonly sessionID: string;
    readonly seam: RuntimeEventRecord["seam"];
    readonly stage: string;
    readonly payload: unknown;
  }): Promise<void>;
  writeMessagesTransformSnapshot(input: {
    readonly sessionID: string;
    readonly phase: "hook-in" | "projection-in" | "out";
    readonly payload: unknown;
  }): Promise<void>;
  writeDiagnostic(input: {
    readonly sessionID: string;
    readonly scope: string;
    readonly severity: RuntimeDiagnosticSeverity;
    readonly message: string;
    readonly payload?: unknown;
  }): Promise<void>;
}

export function createNoopRuntimeArtifactRecorder(): RuntimeArtifactRecorder {
  return {
    async recordEvent() {
      return;
    },
    async writeMessagesTransformSnapshot() {
      return;
    },
    async writeDiagnostic() {
      return;
    },
  } satisfies RuntimeArtifactRecorder;
}

export function createFileBackedRuntimeArtifactRecorder(options: {
  readonly pluginDirectory: string;
  readonly runtimeLogPath: string;
  readonly seamLogPath: string;
  readonly debugSnapshotPath?: string;
  readonly loggingLevel: RuntimeLogLevel;
  readonly now?: () => string;
}): RuntimeArtifactRecorder {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async recordEvent(input) {
      const layout = resolveSessionSidecarLayout({
        pluginDirectory: options.pluginDirectory,
        sessionID: input.sessionID,
        runtimeLogPath: options.runtimeLogPath,
        seamLogPath: options.seamLogPath,
        debugSnapshotPath: options.debugSnapshotPath,
      });
      const event: RuntimeEventRecord = Object.freeze({
        createdAt: now(),
        sessionID: input.sessionID,
        seam: input.seam,
        stage: input.stage,
        payload: input.payload,
      });

      await ensureParentDirectory(layout.runtimeLogPath);
      await appendFile(layout.runtimeLogPath, `${JSON.stringify(event)}\n`, "utf8");
    },
    async writeMessagesTransformSnapshot(input) {
      if (options.debugSnapshotPath === undefined) {
        return;
      }

      const layout = resolveSessionSidecarLayout({
        pluginDirectory: options.pluginDirectory,
        sessionID: input.sessionID,
        runtimeLogPath: options.runtimeLogPath,
        seamLogPath: options.seamLogPath,
        debugSnapshotPath: options.debugSnapshotPath,
      });
      const filePath =
        input.phase === "hook-in"
          ? layout.debugSnapshotHookInputPath
          : input.phase === "projection-in"
            ? layout.debugSnapshotProjectionInputPath
            : layout.debugSnapshotOutputPath;

      if (filePath === undefined) {
        return;
      }

      await ensureParentDirectory(filePath);
      await writeFile(filePath, `${JSON.stringify(input.payload, null, 2)}\n`, "utf8");
    },
    async writeDiagnostic(input) {
      if (!shouldWriteDiagnostic(options.loggingLevel, input.severity)) {
        return;
      }

      const layout = resolveSessionSidecarLayout({
        pluginDirectory: options.pluginDirectory,
        sessionID: input.sessionID,
        runtimeLogPath: options.runtimeLogPath,
        seamLogPath: options.seamLogPath,
        debugSnapshotPath: options.debugSnapshotPath,
      });
      const event: RuntimeDiagnosticRecord = Object.freeze({
        createdAt: now(),
        sessionID: input.sessionID,
        scope: input.scope,
        severity: input.severity,
        message: input.message,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      });

      await ensureParentDirectory(layout.runtimeLogPath);
      await appendFile(layout.runtimeLogPath, `${JSON.stringify(event)}\n`, "utf8");
    },
  } satisfies RuntimeArtifactRecorder;
}

function shouldWriteDiagnostic(
  configuredLevel: RuntimeLogLevel,
  severity: RuntimeDiagnosticSeverity,
): boolean {
  const ranks: Record<RuntimeLogLevel | RuntimeDiagnosticSeverity, number> = {
    off: 99,
    error: 0,
    info: 1,
    debug: 2,
  };

  return ranks[severity] <= ranks[configuredLevel];
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
