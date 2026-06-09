import { tool, type ToolDefinition } from "@opencode-ai/plugin";

export const CONTEXT_COMPRESSION_NOTICE_TOOL_NAME =
  "opencode_context_compression_notice";

export function createContextCompressionNoticeTool(): ToolDefinition {
  return tool({
    description:
      "Never call this tool. This tool only returns context-management reminders; you need to pay attention to its returned content and handle context according to it.",
    args: {},
    async execute() {
      return "";
    },
  });
}
