import type { Plugin } from "@opencode-ai/plugin";

import { loadRuntimeConfig } from "./config/runtime-config.js";
import {
  createStaticChatParamsScheduler,
} from "./runtime/chat-params-scheduler.js";
import { createContextCompressionHooks } from "./runtime/plugin-hooks.js";
import { createDefaultToolExecutionGate } from "./runtime/send-entry-gate.js";
import {
  createCompressionMarkAdmission,
} from "./tools/compression-mark.js";

const plugin: Plugin = async () => {
  const runtimeConfig = loadRuntimeConfig();

  return createContextCompressionHooks({
    seamLogPath: runtimeConfig.seamLogPath,
    chatParamsScheduler: createStaticChatParamsScheduler(),
    toolExecutionGate: createDefaultToolExecutionGate(),
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
