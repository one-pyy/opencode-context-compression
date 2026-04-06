import type { PluginInput } from "@opencode-ai/plugin";

import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import {
  createHistoryBackedChatParamsScheduler,
  createRuntimeChatParamsSchedulerService,
} from "./chat-params-scheduler.js";
import type { RuntimePluginSeamServices } from "./plugin-hooks.js";
import { resolvePluginLockDirectory } from "./file-lock.js";

export function createDefaultRuntimePluginSeamServices(
  input: PluginInput,
  runtimeConfig: LoadedRuntimeConfig,
): RuntimePluginSeamServices {
  return {
    chatParamsScheduler: createRuntimeChatParamsSchedulerService({
      scheduler: createHistoryBackedChatParamsScheduler({
        lockDirectory: resolvePluginLockDirectory(input.directory),
        schedulerMarkThreshold: runtimeConfig.schedulerMarkThreshold,
        readLockNow: Date.now,
        readSessionMessages: (sessionId) =>
          readSessionMessagesFromHost(input, sessionId),
      }),
    }),
    toolExecutionGate: {
      beforeExecution(input) {
        return {
          lane: input.tool === "compression_mark" ? "dcp" : "passthrough",
          blocked: false,
        } as const;
      },
    },
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
