import type { PluginInput } from "@opencode-ai/plugin";

import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import {
  createStaticChatParamsScheduler,
} from "./chat-params-scheduler.js";
import { createDefaultMessagesTransformProjector } from "./default-messages-transform.js";
import type { RuntimePluginSeamServices } from "./plugin-hooks.js";
import { resolvePluginLockDirectory } from "./file-lock.js";
import {
  createDefaultToolExecutionGate,
  createFileLockBackedSendEntryGate,
} from "./send-entry-gate.js";
import { createFileBackedRuntimeArtifactRecorder } from "./runtime-artifacts.js";

export function createDefaultRuntimePluginSeamServices(
  input: PluginInput,
  runtimeConfig: LoadedRuntimeConfig,
): RuntimePluginSeamServices {
  const lockDirectory = resolvePluginLockDirectory(input.directory);

  return {
    runtimeArtifacts: createFileBackedRuntimeArtifactRecorder({
      pluginDirectory: runtimeConfig.repoRoot,
      runtimeLogPath: runtimeConfig.runtimeLogPath,
      seamLogPath: runtimeConfig.seamLogPath,
      debugSnapshotPath: runtimeConfig.debugSnapshotPath,
      loggingLevel: runtimeConfig.logging.level,
    }),
    messagesTransformProjector: createDefaultMessagesTransformProjector({
      pluginDirectory: input.directory,
      runtimeConfig,
      readSessionMessages: (sessionId) =>
        readSessionMessagesFromHost(input, sessionId),
      onProjectionInputRead: async ({ sessionId, messages }) => {
        await createFileBackedRuntimeArtifactRecorder({
          pluginDirectory: runtimeConfig.repoRoot,
          runtimeLogPath: runtimeConfig.runtimeLogPath,
          seamLogPath: runtimeConfig.seamLogPath,
          debugSnapshotPath: runtimeConfig.debugSnapshotPath,
          loggingLevel: runtimeConfig.logging.level,
        }).writeMessagesTransformSnapshot({
          sessionID: sessionId,
          phase: "projection-in",
          payload: { messages },
        });
      },
    }),
    // Compaction is evaluated by messages.transform; this seam only records completion.
    chatParamsScheduler: createStaticChatParamsScheduler({
      evaluationPerformed: false,
      schedulerState: "idle",
      scheduled: false,
      reason: "chat.params evaluation skipped; compaction is handled by messages.transform",
      activeCompactionLock: false,
      pendingMarkCount: 0,
    }),
    sendEntryGate: createFileLockBackedSendEntryGate({
      lockDirectory,
      timeoutMs: runtimeConfig.compressing.timeoutMs,
    }),
    toolExecutionGate: createDefaultToolExecutionGate(),
  } satisfies RuntimePluginSeamServices;
}

async function readSessionMessagesFromHost(
  input: PluginInput,
  sessionId: string,
) {
  const response = await input.client.session.messages({
    path: { id: sessionId },
    query: { directory: input.directory },
    throwOnError: true,
  });

  return response.data;
}
