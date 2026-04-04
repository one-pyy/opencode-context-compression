import type { Hooks } from "@opencode-ai/plugin";

import type { ReminderRuntimeConfig } from "../config/runtime-config.js";
import type {
  MessagesTransformOutput,
  TransformEnvelope,
} from "../seams/noop-observation.js";
import { createSqliteSessionStateStore } from "../state/store.js";
import { resolveHostMessageCanonicalIdentity } from "../identity/canonical-identity.js";
import { buildProjectedMessages } from "./projection-builder.js";

const PROJECTED_ENVELOPE_MARKER = Symbol(
  "opencode-context-compression.projected-envelope",
);
const CANONICAL_SNAPSHOT_MARKER = Symbol(
  "opencode-context-compression.canonical-snapshot",
);

type MessagesTransformHook = NonNullable<
  Hooks["experimental.chat.messages.transform"]
>;
type ProjectionManagedMessages = MessagesTransformOutput["messages"] & {
  [CANONICAL_SNAPSHOT_MARKER]?: readonly TransformEnvelope[];
};

export interface CreateMessagesTransformHookOptions {
  readonly pluginDirectory: string;
  readonly reminder?: ReminderRuntimeConfig;
  readonly smallUserMessageThreshold?: number;
  readonly reminderModelName?: string;
}

export function createMessagesTransformHook(
  options: CreateMessagesTransformHookOptions,
): MessagesTransformHook {
  return async (_input, output) => {
    const managedMessages = output.messages as ProjectionManagedMessages;
    const canonicalMessages = readCanonicalMessages(managedMessages);
    const sessionID = resolveSessionID(canonicalMessages);
    if (sessionID === undefined) {
      return;
    }

    const store = createSqliteSessionStateStore({
      pluginDirectory: options.pluginDirectory,
      sessionID,
    });

    try {
      syncCanonicalMessages(store, canonicalMessages);

      const projection = buildProjectedMessages({
        messages: canonicalMessages,
        store,
        reminder: options.reminder,
        smallUserMessageThreshold: options.smallUserMessageThreshold,
        reminderModelName: options.reminderModelName,
      });
      const projectedMessages = projection.projectedMessages.map(
        markProjectedEnvelope,
      );

      managedMessages.splice(0, managedMessages.length, ...projectedMessages);
      rememberCanonicalMessages(managedMessages, canonicalMessages);
    } finally {
      store.close();
    }
  };
}

function readCanonicalMessages(
  messages: ProjectionManagedMessages,
): TransformEnvelope[] {
  const remembered = messages[CANONICAL_SNAPSHOT_MARKER];
  if (remembered !== undefined && messages.every(isProjectedEnvelope)) {
    return cloneEnvelopes(remembered);
  }

  return cloneEnvelopes(messages);
}

function rememberCanonicalMessages(
  messages: ProjectionManagedMessages,
  canonicalMessages: readonly TransformEnvelope[],
): void {
  Object.defineProperty(messages, CANONICAL_SNAPSHOT_MARKER, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: cloneEnvelopes(canonicalMessages),
  });
}

function isProjectedEnvelope(envelope: TransformEnvelope): boolean {
  return Boolean(
    (envelope as TransformEnvelope & { [PROJECTED_ENVELOPE_MARKER]?: true })[
      PROJECTED_ENVELOPE_MARKER
    ],
  );
}

function markProjectedEnvelope(envelope: TransformEnvelope): TransformEnvelope {
  Object.defineProperty(envelope, PROJECTED_ENVELOPE_MARKER, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: true,
  });

  return envelope;
}

function cloneEnvelopes(
  messages: readonly TransformEnvelope[],
): TransformEnvelope[] {
  return messages.map((message) => structuredClone(message));
}

function resolveSessionID(
  messages: readonly TransformEnvelope[],
): string | undefined {
  for (const message of messages) {
    if (
      typeof message.info.sessionID === "string" &&
      message.info.sessionID.length > 0
    ) {
      return message.info.sessionID;
    }

    for (const part of message.parts) {
      if (typeof part.sessionID === "string" && part.sessionID.length > 0) {
        return part.sessionID;
      }
    }
  }

  return undefined;
}

function syncCanonicalMessages(
  store: ReturnType<typeof createSqliteSessionStateStore>,
  messages: readonly TransformEnvelope[],
): void {
  store.syncCanonicalHostMessages({
    messages: messages.map((message) => {
      const identity = resolveHostMessageCanonicalIdentity(message);
      return {
        hostMessageID: identity.hostMessageID,
        canonicalMessageID: identity.canonicalMessageID,
        role: identity.role,
        hostCreatedAtMs: identity.hostCreatedAtMs,
      };
    }),
  });
}
