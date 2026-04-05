import type { Hooks } from "@opencode-ai/plugin";

import type { ReminderRuntimeConfig } from "../config/runtime-config.js";
import type {
  MessagesTransformOutput,
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../seams/noop-observation.js";
import { createSqliteSessionStateStore } from "../state/store.js";
import {
  readPromptVisibleIdentityMetadata,
  resolveHostMessageCanonicalIdentity,
} from "../identity/canonical-identity.js";
import { renderVisibleIdentityToken } from "../identity/visible-sequence.js";
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
  readonly createStore?: (input: {
    readonly pluginDirectory: string;
    readonly sessionID: string;
  }) => ReturnType<typeof createSqliteSessionStateStore>;
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

    const effectiveStore =
      options.createStore?.({
        pluginDirectory: options.pluginDirectory,
        sessionID,
      }) ??
      createSqliteSessionStateStore({
        pluginDirectory: options.pluginDirectory,
        sessionID,
      });

    try {
      syncCanonicalMessages(effectiveStore, canonicalMessages);

      const projection = buildProjectedMessages({
        messages: canonicalMessages,
        store: effectiveStore,
        reminder: options.reminder,
        smallUserMessageThreshold: options.smallUserMessageThreshold,
        reminderModelName: options.reminderModelName,
      });
      const projectedMessages = materializeProjectedMessages(
        projection.projectedMessages,
      ).map(markProjectedEnvelope);

      managedMessages.splice(0, managedMessages.length, ...projectedMessages);
      rememberCanonicalMessages(managedMessages, canonicalMessages);
    } finally {
      effectiveStore.close();
    }
  };
}

export function materializeProjectedMessages(
  messages: readonly TransformEnvelope[],
): TransformEnvelope[] {
  return messages.map((message) => materializeProjectedEnvelope(structuredClone(message)));
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

function materializeProjectedEnvelope(envelope: TransformEnvelope): TransformEnvelope {
  const promptVisible = readPromptVisibleIdentityMetadata(envelope.info);
  if (promptVisible === undefined) {
    return envelope;
  }

  const identityToken = renderVisibleIdentityToken(
    promptVisible.visibleState,
    promptVisible.visibleMessageID,
  );
  const role = readMessageRole(envelope.info);

  if (role === "assistant") {
    materializeAssistantEnvelope(envelope, identityToken);
    return envelope;
  }

  if (role === "tool") {
    materializeToolEnvelope(envelope, identityToken);
    return envelope;
  }

  materializeCanonicalEnvelope(envelope, identityToken);
  return envelope;
}

function materializeAssistantEnvelope(
  envelope: TransformEnvelope,
  identityToken: string,
): void {
  const firstTextPart = envelope.parts.find(isTextPart);
  if (firstTextPart !== undefined) {
    firstTextPart.text = prependIdentityToken(firstTextPart.text, identityToken);
    return;
  }

  const firstInputTextPart = envelope.parts.find(isInputTextPart);
  if (firstInputTextPart !== undefined) {
    (firstInputTextPart as TransformPart & { text: string }).text =
      prependIdentityToken(
        (firstInputTextPart as TransformPart & { text: string }).text,
        identityToken,
      );
    return;
  }

  envelope.parts.unshift(
    createTextPart(envelope.info, `${envelope.info.id}:dcp-assistant-shell`, identityToken),
  );
}

function materializeToolEnvelope(
  envelope: TransformEnvelope,
  identityToken: string,
): void {
  const firstTextPart = envelope.parts.find(isTextPart);
  if (firstTextPart !== undefined) {
    firstTextPart.text = prependIdentityToken(firstTextPart.text, identityToken);
    return;
  }

  const firstInputTextIndex = envelope.parts.findIndex(isInputTextPart);
  if (firstInputTextIndex >= 0) {
    envelope.parts.splice(
      firstInputTextIndex,
      0,
      createInputTextPart(
        envelope.info,
        `${envelope.info.id}:dcp-input-prefix`,
        identityToken,
      ),
    );
    return;
  }

  envelope.parts.unshift(
    createTextPart(envelope.info, `${envelope.info.id}:dcp-prefix`, identityToken),
  );
}

function materializeCanonicalEnvelope(
  envelope: TransformEnvelope,
  identityToken: string,
): void {
  const firstTextPart = envelope.parts.find(isTextPart);
  if (firstTextPart !== undefined) {
    firstTextPart.text = prependIdentityToken(firstTextPart.text, identityToken);
    return;
  }

  const firstInputTextPart = envelope.parts.find(isInputTextPart);
  if (firstInputTextPart !== undefined) {
    (firstInputTextPart as TransformPart & { text: string }).text =
      prependIdentityToken(
        (firstInputTextPart as TransformPart & { text: string }).text,
        identityToken,
      );
    return;
  }

  envelope.parts.unshift(
    createTextPart(envelope.info, `${envelope.info.id}:dcp-prefix`, identityToken),
  );
}

function prependIdentityToken(text: string | undefined, identityToken: string): string {
  return text && text.length > 0 ? `${identityToken} ${text}` : identityToken;
}

function readMessageRole(message: TransformMessage): string | undefined {
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : undefined;
}

function isTextPart(
  part: TransformPart,
): part is TransformPart & { type: "text"; text: string } {
  return (
    part.type === "text" &&
    typeof (part as Record<string, unknown>).text === "string"
  );
}

function isInputTextPart(
  part: TransformPart,
): part is TransformPart & { type: "input_text"; text: string } {
  return (
    (part as Record<string, unknown>).type === "input_text" &&
    typeof (part as Record<string, unknown>).text === "string"
  );
}

function createTextPart(
  info: TransformMessage,
  id: string,
  text: string,
): TransformPart {
  return {
    id,
    sessionID: info.sessionID,
    messageID: info.id,
    type: "text",
    text,
  } as TransformPart;
}

function createInputTextPart(
  info: TransformMessage,
  id: string,
  text: string,
): TransformPart {
  return {
    id,
    sessionID: info.sessionID,
    messageID: info.id,
    type: "input_text",
    text,
  } as unknown as TransformPart;
}
