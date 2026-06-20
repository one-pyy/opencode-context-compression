import { tool, type ToolDefinition } from "@opencode-ai/plugin";

export const CONTEXT_COMPRESSION_NOTICE_TOOL_NAME =
  "opencode_context_compression_notice";

export const CONTEXT_COMPRESSION_NOTICE_DIRECT_CALL_MESSAGE =
  "Error: This tool is reserved for projected context-compression reminders and must not be called directly by the model. Read existing opencode_context_compression_notice tool results in the conversation instead.";

export function createContextCompressionNoticeTool(): ToolDefinition {
  return tool({
    description:
      "Never call this tool. This tool only returns context-management reminders; you need to pay attention to its returned content and handle context according to it.",
    args: {},
    async execute() {
      return CONTEXT_COMPRESSION_NOTICE_DIRECT_CALL_MESSAGE;
    },
  });
}
