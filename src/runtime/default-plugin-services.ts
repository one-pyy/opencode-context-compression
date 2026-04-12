import type { PluginInput } from "@opencode-ai/plugin";

import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import {
  createHistoryBackedChatParamsScheduler,
  createRuntimeChatParamsSchedulerService,
} from "./chat-params-scheduler.js";
import { createDefaultMessagesTransformProjector } from "./default-messages-transform.js";
import type { RuntimePluginSeamServices } from "./plugin-hooks.js";
import { resolvePluginLockDirectory } from "./file-lock.js";
import {
  createDefaultToolExecutionGate,
  createFileLockBackedSendEntryGate,
} from "./send-entry-gate.js";
import {
  resolvePluginStateDirectory,
  resolveSessionDatabasePath,
} from "./sidecar-layout.js";
import {
  bootstrapSessionSidecar,
  openSessionSidecarRepository,
} from "../state/sidecar-store.js";
import { createResultGroupRepository } from "../state/result-group-repository.js";
import { createFileBackedRuntimeArtifactRecorder } from "./runtime-artifacts.js";

export function createDefaultRuntimePluginSeamServices(
  input: PluginInput,
  runtimeConfig: LoadedRuntimeConfig,
): RuntimePluginSeamServices {
  const lockDirectory = resolvePluginLockDirectory(input.directory);

  return {
    runtimeArtifacts: createFileBackedRuntimeArtifactRecorder({
      pluginDirectory: input.directory,
      runtimeLogPath: runtimeConfig.runtimeLogPath,
      seamLogPath: runtimeConfig.seamLogPath,
      debugSnapshotPath: runtimeConfig.debugSnapshotPath,
    }),
    messagesTransformProjector: createDefaultMessagesTransformProjector({
      pluginDirectory: input.directory,
      runtimeConfig,
      readSessionMessages: (sessionId) =>
        readSessionMessagesFromHost(input, sessionId),
    }),
    chatParamsScheduler: createRuntimeChatParamsSchedulerService({
      scheduler: createHistoryBackedChatParamsScheduler({
        lockDirectory,
        schedulerMarkThreshold: runtimeConfig.schedulerMarkThreshold,
        markedTokenAutoCompactionThreshold:
          runtimeConfig.markedTokenAutoCompactionThreshold,
        readLockNow: Date.now,
        readSessionMessages: (sessionId) =>
          readSessionMessagesFromHost(input, sessionId),
        loadCommittedResultGroups: (sessionId, startSeq, endSeq) =>
          listCommittedResultGroupsForSessionRange({
            pluginDirectory: input.directory,
            sessionId,
            startSeq,
            endSeq,
          }),
      }),
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

async function listCommittedResultGroupsForSessionRange(input: {
  readonly pluginDirectory: string;
  readonly sessionId: string;
  readonly startSeq: number;
  readonly endSeq: number;
}) {
  const stateDirectory = resolvePluginStateDirectory(input.pluginDirectory);
  const databasePath = resolveSessionDatabasePath(stateDirectory, input.sessionId);
  await bootstrapSessionSidecar({ databasePath });

  const sidecar = await openSessionSidecarRepository({ databasePath });
  try {
    return await createResultGroupRepository(sidecar).listGroupsOverlappingRange(
      input.startSeq,
      input.endSeq,
    );
  } finally {
    sidecar.close();
  }
}
