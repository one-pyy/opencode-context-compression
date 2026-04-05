import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import type { CanonicalCompactionMessage } from "../compaction/input-builder.js";
import {
  runCompactionBatch,
  type CompactionRunnerTransport,
} from "../compaction/runner.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { resolveHostMessageCanonicalIdentity } from "../identity/canonical-identity.js";
import type {
  TransformEnvelope,
  TransformPart,
} from "../seams/noop-observation.js";
import { createSqliteSessionStateStore } from "../state/store.js";
import { estimateEnvelopeTokens } from "../token-estimation.js";
import { createDefaultRuntimeCompactionTransport } from "./default-compaction-transport.js";
import {
  readSessionFileLock,
  resolvePluginLockDirectory,
} from "./file-lock.js";
import { createRuntimeEventWriter } from "./runtime-events.js";

type ChatParamsHook = NonNullable<Hooks["chat.params"]>;

type SchedulerSessionMessage = {
  readonly info: Record<string, unknown>;
  readonly parts: readonly Record<string, unknown>[];
};

type SchedulerClient = PluginInput["client"] & {
  session?: {
    messages?: (input: {
      sessionID: string;
      limit?: number;
      before?: string;
    }) => Promise<unknown>;
  };
};

export interface CreateChatParamsSchedulerHookOptions {
  readonly pluginDirectory: string;
  readonly client: PluginInput["client"];
  readonly runtimeConfig: RuntimeConfig;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly runInBackground?: boolean;
  readonly transport?: CompactionRunnerTransport;
  readonly onBackgroundError?: (error: unknown) => void;
}

const ACTIVE_SCHEDULER_RUNS = new Map<string, Promise<void>>();

export function createChatParamsSchedulerHook(
  options: CreateChatParamsSchedulerHookOptions,
): ChatParamsHook {
  return async (input) => {
    const scheduledRun = dispatchSchedulerRun(options, input);
    if (options.runInBackground === false) {
      await scheduledRun;
    }
  };
}

function dispatchSchedulerRun(
  options: CreateChatParamsSchedulerHookOptions,
  input: Parameters<ChatParamsHook>[0],
): Promise<void> {
  const sessionID = input.sessionID;
  const current = ACTIVE_SCHEDULER_RUNS.get(sessionID);
  if (current) {
    return current;
  }

  const run = runSchedulerOnce(options, input).finally(() => {
    if (ACTIVE_SCHEDULER_RUNS.get(sessionID) === run) {
      ACTIVE_SCHEDULER_RUNS.delete(sessionID);
    }
  });

  ACTIVE_SCHEDULER_RUNS.set(sessionID, run);

  if (options.runInBackground !== false) {
    void run.catch((error) => {
      options.onBackgroundError?.(error);
    });
  }

  return run;
}

async function runSchedulerOnce(
  options: CreateChatParamsSchedulerHookOptions,
  input: Parameters<ChatParamsHook>[0],
): Promise<void> {
  const sessionID = input.sessionID;
  const triggerMessageID = input.message.id;
  const lockDirectory = resolvePluginLockDirectory(options.pluginDirectory);
  const store = createSqliteSessionStateStore({
    pluginDirectory: options.pluginDirectory,
    sessionID,
    now: options.now,
  });

  try {
    const lockState = await readSessionFileLock({
      lockDirectory,
      sessionID,
      now: options.now,
      timeoutMs: options.timeoutMs,
    });
    if (isLiveCompactionLock(lockState.kind)) {
      return;
    }

    const canonicalMessages = await syncCanonicalSessionHistory({
      client: options.client,
      sessionID,
      store,
      now: options.now,
    });

    const activeMarks = store.listMarks({ status: "active" });
    const activeMarkedTokenTotal = computeActiveMarkedTokenTotal({
      activeMarks,
      store,
      canonicalMessages,
      modelName: options.runtimeConfig.models[0],
    });
    if (
      activeMarks.length < options.runtimeConfig.schedulerMarkThreshold ||
      activeMarkedTokenTotal <
        options.runtimeConfig.markedTokenAutoCompactionThreshold
    ) {
      return;
    }

    const transport =
      options.transport ??
      createDefaultRuntimeCompactionTransport({
        modelContext: input.model,
        providerContext: input.provider,
        timeoutMs: options.timeoutMs,
      });
    await runCompactionBatch({
      store,
      lockDirectory,
      sessionID,
      promptText: options.runtimeConfig.promptText,
      models: options.runtimeConfig.models,
      transport,
      loadCanonicalSourceMessages:
        createCanonicalSourceLoader(canonicalMessages),
      now: options.now,
      timeoutMs: options.timeoutMs,
      note: `chat.params scheduler triggered by ${triggerMessageID}`,
      runtimeEvents: createRuntimeEventWriter({
        filePath: options.runtimeConfig.runtimeLogPath,
        level: options.runtimeConfig.logging.level,
      }),
      metadata: {
        scheduler: {
          seam: "chat.params",
          triggerMessageID,
          activeMarkCount: activeMarks.length,
          activeMarkedTokenTotal,
          schedulerMarkThreshold: options.runtimeConfig.schedulerMarkThreshold,
          markedTokenAutoCompactionThreshold:
            options.runtimeConfig.markedTokenAutoCompactionThreshold,
          markedTokenThresholdEnforced: true,
          configuredModels: [...options.runtimeConfig.models],
        },
      },
    });
  } finally {
    store.close();
  }
}

function isLiveCompactionLock(
  kind: Awaited<ReturnType<typeof readSessionFileLock>>["kind"],
): kind is "running" {
  return kind === "running";
}

async function syncCanonicalSessionHistory(input: {
  readonly client: PluginInput["client"];
  readonly sessionID: string;
  readonly store: ReturnType<typeof createSqliteSessionStateStore>;
  readonly now?: () => number;
}): Promise<TransformEnvelope[]> {
  const messages = await readSessionMessages(input.client, input.sessionID);
  const envelopes = messages.map(toTransformEnvelope);

  input.store.syncCanonicalHostMessages({
    syncedAtMs: input.now?.(),
    messages: envelopes.map((message) => {
      const identity = resolveHostMessageCanonicalIdentity(message);
      return {
        hostMessageID: identity.hostMessageID,
        canonicalMessageID: identity.canonicalMessageID,
        role: identity.role,
        hostCreatedAtMs: identity.hostCreatedAtMs,
      };
    }),
  });

  return envelopes;
}

async function readSessionMessages(
  client: PluginInput["client"],
  sessionID: string,
): Promise<SchedulerSessionMessage[]> {
  const sessionClient = (client as SchedulerClient).session;
  if (typeof sessionClient?.messages !== "function") {
    throw new Error(
      "chat.params scheduler requires client.session.messages() to read canonical session history.",
    );
  }

  const response = await sessionClient.messages({ sessionID, limit: 500 });
  const data = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.data)
      ? response.data
      : undefined;

  if (!Array.isArray(data)) {
    throw new Error(
      "client.session.messages() did not return an array of session messages.",
    );
  }

  return data.map((message) => {
    if (
      !isRecord(message) ||
      !isRecord(message.info) ||
      !Array.isArray(message.parts)
    ) {
      throw new Error(
        "client.session.messages() returned an invalid session message envelope.",
      );
    }

    return {
      info: message.info,
      parts: message.parts.filter(isRecord),
    } satisfies SchedulerSessionMessage;
  });
}

function createCanonicalSourceLoader(
  canonicalMessages: readonly TransformEnvelope[],
) {
  const messagesByHostID = new Map<string, TransformEnvelope>(
    canonicalMessages.map((message) => [
      resolveHostMessageCanonicalIdentity(message).hostMessageID,
      message,
    ]),
  );

  return async ({
    sourceMessages,
  }: {
    readonly sourceMessages: readonly {
      readonly hostMessageID: string;
      readonly canonicalMessageID: string;
      readonly hostRole: string;
    }[];
  }): Promise<readonly CanonicalCompactionMessage[]> =>
    sourceMessages.map((sourceMessage) => {
      const envelope = messagesByHostID.get(sourceMessage.hostMessageID);
      if (!envelope) {
        throw new Error(
          `Missing canonical content for '${sourceMessage.hostMessageID}'.`,
        );
      }

      const identity = resolveHostMessageCanonicalIdentity(envelope);
      return {
        hostMessageID: identity.hostMessageID,
        canonicalMessageID: identity.canonicalMessageID,
        role: identity.role,
        content: renderCanonicalMessageText(envelope.parts),
      } satisfies CanonicalCompactionMessage;
    });
}

function renderCanonicalMessageText(parts: readonly TransformPart[]): string {
  const chunks = parts.flatMap((part) => {
    if (
      part.type === "text" &&
      typeof (part as TransformPart & { text?: unknown }).text === "string"
    ) {
      return [(part as TransformPart & { text: string }).text];
    }

    return [];
  });

  return chunks.join("\n").trim();
}

function computeActiveMarkedTokenTotal(input: {
  readonly activeMarks: readonly ReturnType<
    ReturnType<typeof createSqliteSessionStateStore>["listMarks"]
  >[number][];
  readonly store: ReturnType<typeof createSqliteSessionStateStore>;
  readonly canonicalMessages: readonly TransformEnvelope[];
  readonly modelName?: string;
}): number {
  const messagesByHostID = new Map(
    input.canonicalMessages.map((message) => [
      resolveHostMessageCanonicalIdentity(message).hostMessageID,
      message,
    ]),
  );

  let total = 0;
  for (const mark of input.activeMarks) {
    const sourceMessages = input.store.listMarkSourceMessages(mark.markID);
    for (const sourceMessage of sourceMessages) {
      const envelope = messagesByHostID.get(sourceMessage.hostMessageID);
      if (envelope === undefined) {
        continue;
      }

      total += estimateEnvelopeTokens({
        envelope,
        modelName: input.modelName,
      }).tokenCount;
    }
  }

  return total;
}

function toTransformEnvelope(
  message: SchedulerSessionMessage,
): TransformEnvelope {
  return {
    info: message.info as TransformEnvelope["info"],
    parts: message.parts as TransformEnvelope["parts"],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
