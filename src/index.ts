import type { Plugin } from "@opencode-ai/plugin";

import { loadRuntimeConfig } from "./config/runtime-config.js";
import { createContextCompressionHooks } from "./runtime/plugin-hooks.js";
import { createDefaultRuntimePluginSeamServices } from "./runtime/default-plugin-services.js";
import { createCompressionMarkAdmission } from "./tools/compression-mark.js";

const plugin: Plugin = async (input) => {
  const runtimeConfig = loadRuntimeConfig();
  const seamServices = createDefaultRuntimePluginSeamServices(
    input,
    runtimeConfig,
  );

  return createContextCompressionHooks({
    seamLogPath: runtimeConfig.seamLogPath,
    ...seamServices,
    compressionMark: {
      admission: createCompressionMarkAdmission({
        allowDelete: runtimeConfig.allowDelete,
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
