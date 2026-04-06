import type { Hooks } from "@opencode-ai/plugin";

import { createFileBackedSeamObservationJournal } from "../seams/file-journal.js";
import {
  createSeamObservationJournal,
  observeChatParams,
  observeMessagesTransform,
  observeToolExecuteBefore,
  type SeamObservationJournal,
} from "../seams/noop-observation.js";
import {
  createChatParamsSchedulerHook,
  type ChatParamsSchedulerService,
} from "./chat-params-scheduler.js";
import {
  createMessagesTransformHook,
  type MessagesTransformProjector,
} from "./messages-transform.js";
import {
  createToolExecuteBeforeHook,
  type ToolExecutionGateService,
} from "./send-entry-gate.js";
import {
  createCompressionMarkTool,
  type CompressionMarkToolOptions,
} from "../tools/compression-mark.js";

export const ALLOWED_PLUGIN_EXTERNAL_HOOKS = Object.freeze([
  "experimental.chat.messages.transform",
  "chat.params",
  "tool.execute.before",
] as const);

export const ALLOWED_PLUGIN_EXTERNAL_TOOLS = Object.freeze([
  "compression_mark",
] as const);

export interface ContextCompressionPluginHooksOptions {
  readonly seamLogPath?: string;
  readonly messagesTransformProjector?: MessagesTransformProjector;
  readonly chatParamsScheduler?: ChatParamsSchedulerService;
  readonly toolExecutionGate?: ToolExecutionGateService;
  readonly compressionMark?: CompressionMarkToolOptions;
}

export function createContextCompressionHooks(
  options: ContextCompressionPluginHooksOptions = {},
): Hooks {
  const journal = createPluginSeamJournal(options.seamLogPath);
  const messagesTransform = createMessagesTransformHook({
    projector: options.messagesTransformProjector,
  });
  const chatParams = createChatParamsSchedulerHook({
    scheduler: options.chatParamsScheduler,
  });
  const toolExecuteBefore = createToolExecuteBeforeHook({
    gate: options.toolExecutionGate,
  });

  return {
    tool: {
      compression_mark: createCompressionMarkTool(options.compressionMark),
    },
    "experimental.chat.messages.transform": async (input, output) => {
      await messagesTransform(input, output);
      journal.record(observeMessagesTransform(input, output));
    },
    "chat.params": async (input, output) => {
      await chatParams(input, output);
      journal.record(observeChatParams(input, output));
    },
    "tool.execute.before": async (input, output) => {
      await toolExecuteBefore(input, output);
      journal.record(observeToolExecuteBefore(input, output));
    },
  } satisfies Hooks;
}

function createPluginSeamJournal(seamLogPath?: string): SeamObservationJournal {
  const baseJournal = createSeamObservationJournal();
  return seamLogPath === undefined
    ? baseJournal
    : createFileBackedSeamObservationJournal(baseJournal, seamLogPath);
}
