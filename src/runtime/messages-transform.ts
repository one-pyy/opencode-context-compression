import type { Hooks } from "@opencode-ai/plugin";

import type { ProjectedMessageSet } from "../projection/types.js";

type MessagesTransformHook = NonNullable<
  Hooks["experimental.chat.messages.transform"]
>;

export type MessagesTransformInput = Parameters<MessagesTransformHook>[0];
export type MessagesTransformOutput = Parameters<MessagesTransformHook>[1];
export type MessagesTransformEnvelope = MessagesTransformOutput["messages"][number];

export interface MessagesTransformProjectionInput {
  readonly input: MessagesTransformInput;
  readonly currentMessages: readonly MessagesTransformEnvelope[];
}

export interface MessagesTransformProjector {
  project(
    input: MessagesTransformProjectionInput,
  ):
    | Promise<readonly MessagesTransformEnvelope[]>
    | readonly MessagesTransformEnvelope[];
}

export interface MessagesTransformExternalContract {
  readonly seam: "experimental.chat.messages.transform";
  readonly inputShape: "host output.messages envelopes";
  readonly outputShape: "mutate output.messages in place";
  readonly callTiming: "immediately before provider request materialization";
  readonly visibleSideEffects: readonly [
    "mutates output.messages in place",
    "is the only seam allowed to render replay-derived prompt changes"
  ];
  readonly errorSemantics: readonly [
    "throws only projection/replay failures",
    "must not schedule compaction or invoke transport"
  ];
  readonly relationToRuntime: {
    readonly replay: "consumes replay-derived state as projection input";
    readonly resultGroups: "may render committed result-groups by markId when projection logic exists";
    readonly scheduler: "read-only relative to scheduler and never dispatches jobs";
  };
}

export const MESSAGES_TRANSFORM_EXTERNAL_CONTRACT = Object.freeze({
  seam: "experimental.chat.messages.transform",
  inputShape: "host output.messages envelopes",
  outputShape: "mutate output.messages in place",
  callTiming: "immediately before provider request materialization",
  visibleSideEffects: [
    "mutates output.messages in place",
    "is the only seam allowed to render replay-derived prompt changes",
  ],
  errorSemantics: [
    "throws only projection/replay failures",
    "must not schedule compaction or invoke transport",
  ],
  relationToRuntime: {
    replay: "consumes replay-derived state as projection input",
    resultGroups:
      "may render committed result-groups by markId when projection logic exists",
    scheduler: "read-only relative to scheduler and never dispatches jobs",
  },
} satisfies MessagesTransformExternalContract);

export function createPassThroughMessagesTransformProjector(): MessagesTransformProjector {
  return {
    project({ currentMessages }) {
      return currentMessages;
    },
  } satisfies MessagesTransformProjector;
}

export function createProjectionBackedMessagesTransformProjector(options: {
  readonly buildProjection: (
    input: MessagesTransformProjectionInput,
  ) => Promise<ProjectedMessageSet> | ProjectedMessageSet;
}): MessagesTransformProjector {
  return {
    async project(input) {
      return projectProjectionToEnvelopes(await options.buildProjection(input));
    },
  } satisfies MessagesTransformProjector;
}

export function createMessagesTransformHook(options: {
  readonly projector?: MessagesTransformProjector;
} = {}): MessagesTransformHook {
  const projector =
    options.projector ?? createPassThroughMessagesTransformProjector();

  return async (input, output) => {
    const nextMessages = await projector.project({
      input,
      currentMessages: output.messages,
    });

    if (nextMessages === output.messages) {
      return;
    }

    output.messages.splice(0, output.messages.length, ...nextMessages);
  };
}

export function projectProjectionToEnvelopes(
  projection: ProjectedMessageSet,
): readonly MessagesTransformEnvelope[] {
  return Object.freeze(
    projection.messages.map((message, index) => {
      const messageId =
        message.canonicalId ??
        message.visibleId ??
        `${message.source}-${projection.sessionId}-${index + 1}`;

      return {
        info: {
          id: messageId,
          sessionID: projection.sessionId,
          role: message.role,
          time: { created: index + 1 },
          agent: "atlas",
          model: {
            providerID: "opencode-context-compression",
            modelID: "projection-replay",
          },
        },
        parts: [
          {
            id: `${messageId}:text`,
            sessionID: projection.sessionId,
            messageID: messageId,
            type: "text",
            text: message.contentText,
          },
        ],
      } as MessagesTransformEnvelope;
    }),
  );
}
