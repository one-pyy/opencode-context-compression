import type { Plugin, PluginModule } from "@opencode-ai/plugin";

import { loadRuntimeConfig } from "./config/runtime-config.js";
import { createContextCompressionHooks } from "./runtime/plugin-hooks.js";
import { createDefaultRuntimePluginSeamServices } from "./runtime/default-plugin-services.js";
import { createCompressionMarkAdmission } from "./tools/compression-mark.js";
import { ToastService } from "./services/toast-service.js";

const plugin: Plugin = async (input) => {
  const runtimeConfig = await loadRuntimeConfig();
  const seamServices = createDefaultRuntimePluginSeamServices(
    input,
    runtimeConfig,
  );

  const toastService = new ToastService(input, runtimeConfig.toast);
  toastService.showPluginStarted().catch(() => {});

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
  });
};

const id = "opencode-context-compression";

export const server: Plugin = plugin;

const pluginModule: PluginModule = {
  id,
  server,
};

export default pluginModule;