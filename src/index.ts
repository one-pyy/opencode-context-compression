import type { Plugin, PluginModule } from "@opencode-ai/plugin";

import { loadRuntimeConfig } from "./config/runtime-config.js";
import { createContextCompressionHooks } from "./runtime/plugin-hooks.js";
import { createDefaultRuntimePluginSeamServices } from "./runtime/default-plugin-services.js";
import { createCompressionMarkAdmission } from "./tools/compression-mark.js";
import { ToastService } from "./services/toast-service.js";
import { createFileBackedRuntimeArtifactRecorder } from "./runtime/runtime-artifacts.js";
import { resolvePluginLockDirectory, clearStaleRunningLocks } from "./runtime/file-lock.js";

const plugin: Plugin = async (input) => {
  const runtimeConfig = await loadRuntimeConfig();
  const lockDirectory = resolvePluginLockDirectory(input.directory);
  const startupArtifacts = createFileBackedRuntimeArtifactRecorder({
    pluginDirectory: runtimeConfig.repoRoot,
    runtimeLogPath: runtimeConfig.runtimeLogPath,
    seamLogPath: runtimeConfig.seamLogPath,
    debugSnapshotPath: runtimeConfig.debugSnapshotPath,
    loggingLevel: runtimeConfig.logging.level,
  });

  // Clear any running locks left by a previous process that exited mid-compaction.
  // After restart no old compaction process can still be alive, so running locks are stale.
  try {
    const result = await clearStaleRunningLocks({ lockDirectory });
    if (result.clearedCount > 0 || result.errors.length > 0) {
      await startupArtifacts.writeDiagnostic({
        sessionID: "plugin-startup",
        scope: "plugin-startup",
        severity: result.errors.length > 0 ? "error" : "info",
        message: "Cleared stale running locks from previous process.",
        payload: {
          clearedCount: result.clearedCount,
          errors: result.errors,
        },
      });
    }
  } catch {
    // Lock cleanup failure is non-fatal — stale locks will still time out naturally.
  }

  const seamServices = createDefaultRuntimePluginSeamServices(
    input,
    runtimeConfig,
  );

  const toastService = new ToastService(input, runtimeConfig.toast);
  await startupArtifacts.writeDiagnostic({
    sessionID: "plugin-startup",
    scope: "plugin-startup",
    severity: "info",
    message: "Attempting startup toast.",
    payload: {
      title: "Context Compression",
      message: "Plugin started and monitoring context usage",
      enabled: runtimeConfig.toast.enabled,
      duration: runtimeConfig.toast.durations.startup,
    },
  });
  void toastService.showPluginStarted().then(
    async (startupToastShown) => {
      await startupArtifacts.writeDiagnostic({
        sessionID: "plugin-startup",
        scope: "plugin-startup",
        severity: startupToastShown ? "info" : "debug",
        message: startupToastShown
          ? "Startup toast request completed."
          : "Startup toast request did not reach TUI or was skipped.",
        payload: {
          shown: startupToastShown,
          enabled: runtimeConfig.toast.enabled,
        },
      });
    },
    async (error) => {
      await startupArtifacts.writeDiagnostic({
        sessionID: "plugin-startup",
        scope: "plugin-startup",
        severity: "error",
        message: "Startup toast request failed unexpectedly.",
        payload: {
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : String(error),
        },
      });
    },
  );

  return createContextCompressionHooks({
    seamLogPath: runtimeConfig.seamLogPath,
    ...seamServices,
    compressionMark: {
      admission: createCompressionMarkAdmission({
        allowDelete: runtimeConfig.allowDelete,
      }),
    },
    toastService,
    pluginDirectory: input.directory,
    pluginInput: input,
    runtimeConfig,
    lockDirectory,
    idleThresholdMs: runtimeConfig.idleThresholdMs,
  });
};

const id = "opencode-context-compression";

export const server: Plugin = plugin;

const pluginModule: PluginModule = {
  id,
  server,
};

export default pluginModule;
