import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { createCanonicalIdentityService } from "../identity/canonical-identity.js";
import { createFlatPolicyEngine } from "../projection/policy-engine.js";
import { createProjectionBuilder } from "../projection/projection-builder.js";
import { createConfiguredReminderService } from "../projection/reminder-service.js";
import {
  resolvePluginStateDirectory,
  resolveSessionDatabasePath,
} from "./sidecar-layout.js";
import { createResultGroupRepository } from "../state/result-group-repository.js";
import {
  bootstrapSessionSidecar,
  openSessionSidecarRepository,
} from "../state/sidecar-store.js";
import {
  createProjectionBackedMessagesTransformProjector,
  type MessagesTransformEnvelope,
  type MessagesTransformProjectionInput,
  type MessagesTransformProjector,
} from "./messages-transform.js";
import {
  createHistoryReplayReaderFromSessionMessages,
  type SessionHistoryReader,
} from "./session-history.js";

export interface DefaultMessagesTransformProjectorOptions {
  readonly pluginDirectory: string;
  readonly runtimeConfig: LoadedRuntimeConfig;
  readonly readSessionMessages: SessionHistoryReader["readSessionMessages"];
  readonly now?: () => string;
}

export function createDefaultMessagesTransformProjector(
  options: DefaultMessagesTransformProjectorOptions,
): MessagesTransformProjector {
  return createProjectionBackedMessagesTransformProjector({
    buildProjection: async (input) => {
      const sessionId = resolveMessagesTransformSessionId(input);
      const stateDirectory = resolvePluginStateDirectory(options.pluginDirectory);
      const databasePath = resolveSessionDatabasePath(stateDirectory, sessionId);
      await bootstrapSessionSidecar({ databasePath });

      const sidecar = await openSessionSidecarRepository({ databasePath });

      try {
        const resultGroups = createResultGroupRepository(sidecar);
        const projectionBuilder = createProjectionBuilder({
          historyReplayReader: createHistoryReplayReaderFromSessionMessages({
            readSessionMessages: options.readSessionMessages,
          }),
          policyEngine: createFlatPolicyEngine({
            smallUserMessageThreshold:
              options.runtimeConfig.smallUserMessageThreshold,
          }),
          resultGroupRepository: resultGroups,
          canonicalIdentityService: createCanonicalIdentityService({
            visibleIds: resultGroups,
            allocateAt: options.now,
          }),
          reminderService: createConfiguredReminderService({
            hsoft: options.runtimeConfig.reminder.hsoft,
            hhard: options.runtimeConfig.reminder.hhard,
            softRepeatEveryTokens:
              options.runtimeConfig.reminder.softRepeatEveryTokens,
            hardRepeatEveryTokens:
              options.runtimeConfig.reminder.hardRepeatEveryTokens,
            allowDelete: options.runtimeConfig.allowDelete,
            promptTextByKind: {
              "soft-compact":
                options.runtimeConfig.reminder.prompts.compactOnly.soft.text,
              "soft-delete":
                options.runtimeConfig.reminder.prompts.deleteAllowed.soft.text,
              "hard-compact":
                options.runtimeConfig.reminder.prompts.compactOnly.hard.text,
              "hard-delete":
                options.runtimeConfig.reminder.prompts.deleteAllowed.hard.text,
            },
          }),
        });

        return await projectionBuilder.build({ sessionId });
      } finally {
        sidecar.close();
      }
    },
  });
}

function resolveMessagesTransformSessionId(
  input: MessagesTransformProjectionInput,
): string {
  const candidate =
    readNonEmptyString(readRecordValue(input.input, "sessionID")) ??
    readNonEmptyString(readRecordValue(input.input, "sessionId")) ??
    readNonEmptyString(input.currentMessages[0]?.info.sessionID);

  if (candidate) {
    return candidate;
  }

  throw new Error(
    "messages.transform requires a sessionID so projection can replay canonical history.",
  );
}

function readRecordValue(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
