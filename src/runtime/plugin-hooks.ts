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
  CHAT_PARAMS_METADATA_KEY,
  createChatParamsSchedulerHook,
  type ChatParamsSchedulerService,
} from "./chat-params-scheduler.js";
import {
  createMessagesTransformHook,
  type MessagesTransformProjector,
  resolveMessagesTransformSessionId,
} from "./messages-transform.js";
import {
  createToolExecuteBeforeHook,
  createDefaultToolExecutionGate,
  createStaticSendEntryGate,
  type SendEntryGate,
  type ToolExecutionGateService,
} from "./send-entry-gate.js";
import {
  createCompressionMarkTool,
  type CompressionMarkToolOptions,
} from "../tools/compression-mark.js";
import {
  createNoopRuntimeArtifactRecorder,
  type RuntimeArtifactRecorder,
} from "./runtime-artifacts.js";
import type { ToastService } from "../services/toast-service.js";
import { openSessionSidecarRepository } from "../state/sidecar-store.js";
import { resolvePluginStateDirectory, resolveSessionDatabasePath } from "./sidecar-layout.js";
import { readPendingToastEvents, markToastEventsProcessed } from "../state/sidecar-store/toast-events.js";
import { executeBackgroundCompactions } from "./background-compaction-executor.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { PluginInput } from "@opencode-ai/plugin";

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
  readonly runtimeArtifacts?: RuntimeArtifactRecorder;
  readonly messagesTransformProjector?: MessagesTransformProjector;
  readonly chatParamsScheduler?: ChatParamsSchedulerService;
  readonly sendEntryGate?: SendEntryGate;
  readonly toolExecutionGate?: ToolExecutionGateService;
  readonly compressionMark?: CompressionMarkToolOptions;
  readonly toastService?: ToastService;
  readonly pluginDirectory?: string;
  readonly pluginInput?: PluginInput;
  readonly runtimeConfig?: LoadedRuntimeConfig;
}

export interface RuntimePluginSeamServices {
  readonly runtimeArtifacts: RuntimeArtifactRecorder;
  readonly messagesTransformProjector: MessagesTransformProjector;
  readonly chatParamsScheduler: ChatParamsSchedulerService;
  readonly sendEntryGate: SendEntryGate;
  readonly toolExecutionGate: ToolExecutionGateService;
}

export function createContextCompressionHooks(
  options: ContextCompressionPluginHooksOptions = {},
): Hooks {
  const journal = createPluginSeamJournal(options.seamLogPath);
  const runtimeArtifacts =
    options.runtimeArtifacts ?? createNoopRuntimeArtifactRecorder();
  const sendEntryGate = options.sendEntryGate ?? createStaticSendEntryGate();
  const messagesTransformProjector = options.messagesTransformProjector;
  const toastService = options.toastService;
  const toolExecutionGate =
    options.toolExecutionGate ?? createDefaultToolExecutionGate();
  const messagesTransform = createMessagesTransformHook({
    projector: messagesTransformProjector,
  });
  const chatParams = createChatParamsSchedulerHook({
    scheduler: options.chatParamsScheduler,
  });
  const toolExecuteBefore = createToolExecuteBeforeHook({
    gate: toolExecutionGate,
  });

  return {
    tool: {
      compression_mark: createCompressionMarkTool(options.compressionMark),
    },
    "experimental.chat.messages.transform": async (input, output) => {
      const sessionID = resolveMessagesTransformSessionId({
        hookInput: input,
        currentMessages: output.messages,
      });
      const gateResult = await sendEntryGate.waitIfNeeded(sessionID);
      await runtimeArtifacts.recordEvent({
        sessionID,
        seam: "experimental.chat.messages.transform",
        stage: "gate",
        payload: gateResult,
      });
      await runtimeArtifacts.writeMessagesTransformSnapshot({
        sessionID,
        phase: "in",
        payload: {
          messages: output.messages,
        },
      });

      try {
        await messagesTransform(input, output);
      } catch (error) {
        await runtimeArtifacts.recordEvent({
          sessionID,
          seam: "experimental.chat.messages.transform",
          stage: "failed",
          payload: serializeError(error),
        });
        throw error;
      }

      await runtimeArtifacts.writeMessagesTransformSnapshot({
        sessionID,
        phase: "out",
        payload: {
          messages: output.messages,
        },
      });
      journal.record(observeMessagesTransform(input, output));
      await runtimeArtifacts.recordEvent({
        sessionID,
        seam: "experimental.chat.messages.transform",
        stage: "completed",
        payload: {
          messageCount: output.messages.length,
          projectionDebug: messagesTransformProjector?.getLastProjectionDebugState?.(),
        },
      });

      const projectionDebug = messagesTransformProjector?.getLastProjectionDebugState?.();
      if (projectionDebug && toastService) {
        const hasSoftReminder = projectionDebug.reminders?.kinds?.some((k: string) => k.startsWith('soft'));
        const hasHardReminder = projectionDebug.reminders?.kinds?.some((k: string) => k.startsWith('hard'));

        if (hasSoftReminder) {
          toastService.showSoftReminder(projectionDebug.totalCompressibleTokenCount ?? 0).catch(() => {});
        }
        if (hasHardReminder) {
          toastService.showHardReminder(projectionDebug.totalCompressibleTokenCount ?? 0).catch(() => {});
        }
      }

      if (toastService && options.pluginDirectory) {
        try {
          const stateDirectory = resolvePluginStateDirectory(options.pluginDirectory);
          const databasePath = resolveSessionDatabasePath(stateDirectory, sessionID);
          const sidecar = await openSessionSidecarRepository({ databasePath });
          
          try {
            const pendingEvents = readPendingToastEvents(sidecar.database);
            const eventIds: number[] = [];
            
            for (const event of pendingEvents) {
              eventIds.push(event.id);
              
              if (event.eventType === "compression_start") {
                toastService.showCompressionStarted().catch(() => {});
              } else if (event.eventType === "compression_complete") {
                const payload = event.payload ? JSON.parse(event.payload) : {};
                toastService.showCompressionCompleted(payload.savedTokens).catch(() => {});
              } else if (event.eventType === "compression_failed") {
                const payload = event.payload ? JSON.parse(event.payload) : {};
                toastService.showCompressionFailed(payload.error).catch(() => {});
              }
            }
            
            if (eventIds.length > 0) {
              markToastEventsProcessed(sidecar.database, eventIds);
            }
          } finally {
            sidecar.close();
          }
        } catch {
        }
      }

      if (options.pluginInput && options.runtimeConfig && options.pluginDirectory) {
        const projectionState = messagesTransformProjector?.getLastProjectionState?.();
        if (projectionState) {
          executeBackgroundCompactions({
            pluginInput: options.pluginInput,
            runtimeConfig: options.runtimeConfig,
            sessionId: sessionID,
            projectionState,
          }).catch((error) => {
            console.error("[plugin-hooks] Background compaction failed:", error);
          });
        }
      }
    },
    "chat.params": async (input, output) => {
      await chatParams(input, output);
      journal.record(observeChatParams(input, output));
      await runtimeArtifacts.recordEvent({
        sessionID: input.sessionID,
        seam: "chat.params",
        stage: "completed",
        payload: output.options[CHAT_PARAMS_METADATA_KEY] ?? null,
      });
    },
    "tool.execute.before": async (input, output) => {
      const gateDecision = await toolExecutionGate.beforeExecution(input);
      await toolExecuteBefore(input, output);
      journal.record(observeToolExecuteBefore(input, output));
      await runtimeArtifacts.recordEvent({
        sessionID: input.sessionID,
        seam: "tool.execute.before",
        stage: "completed",
        payload: {
          tool: input.tool,
          callID: input.callID,
          gateDecision,
        },
      });
    },
  } satisfies Hooks;
}

function createPluginSeamJournal(seamLogPath?: string): SeamObservationJournal {
  const baseJournal = createSeamObservationJournal();
  return seamLogPath === undefined
    ? baseJournal
    : createFileBackedSeamObservationJournal(baseJournal, seamLogPath);
}

function serializeError(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}
