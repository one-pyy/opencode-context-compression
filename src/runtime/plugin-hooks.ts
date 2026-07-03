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
  type MessagesTransformEnvelope,
  resolveMessagesTransformSessionId,
} from "./messages-transform.js";
import {
  createToolExecuteBeforeHook,
  createDefaultToolExecutionGate,
  createStaticSendEntryGate,
  type SendEntryGate,
  type GateResult,
  type ToolExecutionGateService,
} from "./send-entry-gate.js";
import { createTextCompleteHook } from "./text-complete.js";
import {
  createCompressionMarkTool,
  type CompressionMarkToolOptions,
} from "../tools/compression-mark.js";
import {
  createCompressionInspectTool,
  type CompressionInspectToolOptions,
} from "../tools/compression-inspect.js";
import {
  createCompressionRecallTool,
  type CompressionRecallToolOptions,
} from "../tools/compression-recall.js";
import { createContextCompressionNoticeTool } from "../tools/context-compression-notice.js";
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
import {
  evaluateReplacementGate,
  extractLastModelResponseTime,
} from "./replacement-gate.js";
import { readSessionFileLock } from "./file-lock.js";

export const ALLOWED_PLUGIN_EXTERNAL_HOOKS = Object.freeze([
  "experimental.chat.messages.transform",
  "experimental.text.complete",
  "chat.params",
  "tool.execute.before",
] as const);

export const ALLOWED_PLUGIN_EXTERNAL_TOOLS = Object.freeze([
  "compression_mark",
  "compression_inspect",
  "compression_recall",
  "opencode_context_compression_notice",
] as const);

export interface ContextCompressionPluginHooksOptions {
  readonly seamLogPath?: string;
  readonly runtimeArtifacts?: RuntimeArtifactRecorder;
  readonly messagesTransformProjector?: MessagesTransformProjector;
  readonly chatParamsScheduler?: ChatParamsSchedulerService;
  readonly sendEntryGate?: SendEntryGate;
  readonly toolExecutionGate?: ToolExecutionGateService;
  readonly compressionMark?: CompressionMarkToolOptions;
  readonly compressionInspect?: CompressionInspectToolOptions;
  readonly compressionRecall?: CompressionRecallToolOptions;
  readonly toastService?: ToastService;
  readonly pluginDirectory?: string;
  readonly pluginInput?: PluginInput;
  readonly runtimeConfig?: LoadedRuntimeConfig;
  readonly lockDirectory?: string;
  readonly idleThresholdMs?: number;
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
    resolveReplacementGateOpen: ({ currentMessages }) => {
      return computeReplacementGateOpen({
        messagesTransformProjector,
        currentMessages,
        runtimeConfig: options.runtimeConfig,
        idleThresholdMs: options.idleThresholdMs,
      });
    },
  });
  const chatParams = createChatParamsSchedulerHook({
    scheduler: options.chatParamsScheduler,
  });
  const textComplete = createTextCompleteHook();
  const toolExecuteBefore = createToolExecuteBeforeHook({
    gate: toolExecutionGate,
  });

  return {
    tool: {
      compression_mark: createCompressionMarkTool(options.compressionMark),
      compression_inspect: createCompressionInspectTool(options.compressionInspect),
      compression_recall: createCompressionRecallTool(options.compressionRecall),
      opencode_context_compression_notice: createContextCompressionNoticeTool(),
    },
    "experimental.chat.messages.transform": async (input, output) => {
      const sessionID = resolveMessagesTransformSessionId({
        hookInput: input,
        currentMessages: output.messages,
      });

      const gateResult = await conditionalSendEntryGate({
        sessionID,
        sendEntryGate,
        messagesTransformProjector,
        currentMessages: output.messages,
        runtimeConfig: options.runtimeConfig,
        lockDirectory: options.lockDirectory,
        idleThresholdMs: options.idleThresholdMs,
      });

      await runtimeArtifacts.recordEvent({
        sessionID,
        seam: "experimental.chat.messages.transform",
        stage: "gate",
        payload: gateResult,
      });
      await runtimeArtifacts.writeMessagesTransformSnapshot({
        sessionID,
        phase: "hook-in",
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
            runtimeArtifacts,
            sessionId: sessionID,
            projectionState,
          }).catch((error) => {
            runtimeArtifacts.writeDiagnostic({
              sessionID,
              scope: "plugin-hooks",
              severity: "error",
              message: "Background compaction executor failed.",
              payload: { error: serializeError(error) },
            }).catch(() => {});
          });
        }
      }
    },
    "chat.params": async (input, output) => {
      const metadata = await chatParams(input, output);
      journal.record(observeChatParams(input, output));
      await runtimeArtifacts.recordEvent({
        sessionID: input.sessionID,
        seam: "chat.params",
        stage: "completed",
        payload: metadata,
      });
    },
    "experimental.text.complete": async (input, output) => {
      await textComplete(input, output);
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

function computeReplacementGateOpen(options: {
  readonly messagesTransformProjector?: MessagesTransformProjector;
  readonly currentMessages: readonly MessagesTransformEnvelope[];
  readonly runtimeConfig?: LoadedRuntimeConfig;
  readonly idleThresholdMs?: number;
}): boolean {
  const lastState = options.messagesTransformProjector?.getLastProjectionState?.();
  const runtimeConfig = options.runtimeConfig;
  if (!lastState || !runtimeConfig) {
    return true;
  }

  const resultGroupMarkIds = new Set(
    lastState.state.resultGroups.map((group) => group.markId),
  );

  let uncompressedMarkedTokenCount = 0;
  const tokenCountBySequence = new Map(
    lastState.state.messagePolicies.map((policy) => [policy.sequence, policy.tokenCount]),
  );

  function countUncompressed(nodes: readonly import("../projection/types.js").MarkTreeNode[]): number {
    let total = 0;
    for (const node of nodes) {
      if (resultGroupMarkIds.has(node.markId)) {
        continue;
      }
      for (let seq = node.startSequence; seq <= node.endSequence; seq += 1) {
        total += tokenCountBySequence.get(seq) ?? 0;
      }
      total += countUncompressed(node.children);
    }
    return total;
  }

  uncompressedMarkedTokenCount = countUncompressed(lastState.state.markTree.marks);

  const lastModelResponseTime = extractLastModelResponseTime(
    options.currentMessages as readonly { readonly parts?: readonly { readonly type?: string; readonly time?: { readonly start?: number; readonly end?: number } | null }[] }[],
  );

  const idleThresholdMs = options.idleThresholdMs ?? 5 * 60 * 1000;

  const gateResult = evaluateReplacementGate({
    uncompressedMarkedTokenCount,
    markedTokenAutoCompactionThreshold: runtimeConfig.markedTokenAutoCompactionThreshold,
    lastModelResponseTime,
    idleThresholdMs,
    now: Date.now(),
  });

  return gateResult.shouldReplace;
}

async function conditionalSendEntryGate(options: {
  readonly sessionID: string;
  readonly sendEntryGate: SendEntryGate;
  readonly messagesTransformProjector?: MessagesTransformProjector;
  readonly currentMessages: readonly MessagesTransformEnvelope[];
  readonly runtimeConfig?: LoadedRuntimeConfig;
  readonly lockDirectory?: string;
  readonly idleThresholdMs?: number;
}): Promise<GateResult> {
  const replacementGateOpen = computeReplacementGateOpen({
    messagesTransformProjector: options.messagesTransformProjector,
    currentMessages: options.currentMessages,
    runtimeConfig: options.runtimeConfig,
    idleThresholdMs: options.idleThresholdMs,
  });

  if (!replacementGateOpen) {
    return {
      waited: false,
      releasedBy: "no-lock",
      reason: "replacement gate closed, skipping send-entry gate",
    };
  }

  if (options.lockDirectory) {
    const lockState = await readSessionFileLock({
      lockDirectory: options.lockDirectory,
      sessionID: options.sessionID,
    });
    if (lockState.kind === "unlocked") {
      return {
        waited: false,
        releasedBy: "no-lock",
        reason: "replacement gate open but no active lock",
      };
    }
  }

  return options.sendEntryGate.waitIfNeeded(options.sessionID);
}
