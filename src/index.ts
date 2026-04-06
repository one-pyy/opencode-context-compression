import type { Plugin, PluginInput } from "@opencode-ai/plugin";

import { loadRuntimeConfig } from "./config/runtime-config.js";
import {
  createHistoryBackedChatParamsScheduler,
  createRuntimeChatParamsSchedulerService,
} from "./runtime/chat-params-scheduler.js";
import { createContextCompressionHooks } from "./runtime/plugin-hooks.js";
import { resolvePluginLockDirectory } from "./runtime/file-lock.js";
import { createCompressionMarkAdmission } from "./tools/compression-mark.js";

const plugin: Plugin = async (input) => {
  const runtimeConfig = loadRuntimeConfig();

  return createContextCompressionHooks({
    seamLogPath: runtimeConfig.seamLogPath,
    chatParamsScheduler: createRuntimeChatParamsSchedulerService({
      scheduler: createHistoryBackedChatParamsScheduler({
        lockDirectory: resolvePluginLockDirectory(input.directory),
        schedulerMarkThreshold: runtimeConfig.schedulerMarkThreshold,
        readLockNow: Date.now,
        readSessionMessages: (sessionId) =>
          readSessionMessagesFromHost(input, sessionId),
      }),
    }),
    toolExecutionGate: createToolExecutionGate(),
    compressionMark: {
      admission: createCompressionMarkAdmission({
        allowDelete: false,
      }),
    },
  });
};

export default plugin;

export {
  ALLOWED_PLUGIN_EXTERNAL_HOOKS,
  ALLOWED_PLUGIN_EXTERNAL_TOOLS,
  createContextCompressionHooks,
} from "./runtime/plugin-hooks.js";

function createToolExecutionGate() {
  return {
    beforeExecution(input: { readonly tool: string }) {
      return {
        lane:
          input.tool === "compression_mark"
            ? ("dcp" as const)
            : ("passthrough" as const),
        blocked: false as const,
      };
    },
  };
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
