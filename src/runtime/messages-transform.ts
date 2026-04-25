import type { Hooks } from "@opencode-ai/plugin";

import type { ProjectedMessageSet } from "../projection/types.js";
import type { CompleteResultGroup } from "../state/result-group-repository.js";

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
  getLastProjectionDebugState?(): MessagesTransformProjectionDebugState | undefined;
  getLastProjectionState?(): ProjectedMessageSet | undefined;
}

export interface MessagesTransformProjectionDebugState {
  readonly canonicalMessageCount: number;
  readonly projectedMessageCount: number;
  readonly projectedMessageSourceCounts: {
    readonly canonical: number;
    readonly resultGroup: number;
    readonly reminder: number;
    readonly synthetic: number;
  };
  readonly visibleKindCounts: {
    readonly protected: number;
    readonly compressible: number;
    readonly referable: number;
  };
  readonly totalCompressibleTokenCount: number;
  readonly uncompressedMarkedTokenCount: number;
  readonly compressionMarkToolCalls: {
    readonly total: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly invalidInput: number;
    readonly invalidResult: number;
    readonly compact: number;
    readonly delete: number;
    readonly recent: readonly {
      readonly sequence: number;
      readonly sourceMessageId: string;
      readonly outcome: "accepted" | "rejected" | "invalid-input" | "invalid-result";
      readonly mode?: "compact" | "delete";
      readonly errorCode?: string;
    }[];
  };
  readonly replayedMarkIntents: {
    readonly total: number;
    readonly compact: number;
    readonly delete: number;
    readonly ids: readonly string[];
  };
  readonly activeMarkTree: {
    readonly topLevelCount: number;
    readonly totalNodeCount: number;
    readonly ids: readonly string[];
  };
  readonly conflicts: {
    readonly count: number;
    readonly messages: readonly string[];
  };
  readonly resultGroups: {
    readonly count: number;
    readonly fragmentCount: number;
    readonly markIds: readonly string[];
  };
  readonly reminders: {
    readonly count: number;
    readonly kinds: readonly string[];
  };
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
  let lastProjectionDebugState: MessagesTransformProjectionDebugState | undefined;
  let lastProjectionState: ProjectedMessageSet | undefined;

  return {
    async project(input) {
      const projection = await options.buildProjection(input);
      lastProjectionDebugState = summarizeProjectionDebugState(projection);
      lastProjectionState = projection;
      return projectProjectionToEnvelopes(projection);
    },
    getLastProjectionDebugState() {
      return lastProjectionDebugState;
    },
    getLastProjectionState() {
      return lastProjectionState;
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

export function resolveMessagesTransformSessionId(input: {
  readonly hookInput: MessagesTransformInput;
  readonly currentMessages: readonly MessagesTransformEnvelope[];
}): string {
  const candidate =
    readNonEmptyString(readRecordValue(input.hookInput, "sessionID")) ??
    readNonEmptyString(readRecordValue(input.hookInput, "sessionId")) ??
    readNonEmptyString(input.currentMessages[0]?.info.sessionID);

  if (candidate) {
    return candidate;
  }

  throw new Error(
    "messages.transform requires a sessionID so projection can replay canonical history.",
  );
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

      const parts: MessagesTransformEnvelope["parts"] = [];
      const hasRenderableContent = message.contentText.trim().length > 0;
      if (message.parts && message.parts.length > 0) {
        let hasTextPart = false;
        
        for (const part of message.parts) {
          if (part.type === "text") {
            // Use message.contentText for the first text part to preserve visible ID prefix
            const isFirstTextPart = !hasTextPart;
            hasTextPart = true;
            parts.push({
              ...part,
              id: `${messageId}:text:${parts.length}`,
              sessionID: projection.sessionId,
              messageID: messageId,
              type: "text",
              text:
                isFirstTextPart && hasRenderableContent
                  ? message.contentText
                  : (part.text as string),
            } as any);
          } else if (part.type === "reasoning") {
            parts.push({
              ...part,
              id: `${messageId}:reasoning:${parts.length}`,
              sessionID: projection.sessionId,
              messageID: messageId,
              type: "reasoning",
            } as any);
          } else if (part.type === "tool") {
            parts.push({
              ...part,
              id: `${messageId}:tool:${parts.length}`,
              sessionID: projection.sessionId,
              messageID: messageId,
              type: "tool",
            } as any);
          } else if (part.type === "file") {
            parts.push({
              ...part,
              id: `${messageId}:file:${parts.length}`,
              sessionID: projection.sessionId,
              messageID: messageId,
              type: "file",
            } as any);
          } else {
            parts.push({
              ...part,
              id: `${messageId}:${part.type}:${parts.length}`,
              sessionID: projection.sessionId,
              messageID: messageId,
            } as any);
          }
        }
        
        // Keep a synthetic text shell even for the host's trailing empty assistant placeholder
        // so that every visible assistant message still carries a msg_id-bearing text part.
        if (!hasTextPart && hasRenderableContent) {
          parts.unshift({
            id: `${messageId}:text:shell`,
            sessionID: projection.sessionId,
            messageID: messageId,
            type: "text",
            text: message.contentText,
          });
        }
      } else if (hasRenderableContent) {
        parts.push({
          id: `${messageId}:text`,
          sessionID: projection.sessionId,
          messageID: messageId,
          type: "text",
          text: message.contentText,
        });
      }

      // For canonical messages, preserve original info; for synthetic, use projection identity
      const isCanonical = message.source === "canonical";
      const baseInfo = isCanonical && message.hostMessage?.info 
        ? message.hostMessage.info 
        : {
            agent: "atlas",
            model: {
              providerID: "opencode-context-compression",
              modelID: "projection-replay",
            },
          };

      return {
        info: {
          ...baseInfo,
          id: messageId,
          sessionID: projection.sessionId,
          role: message.role,
          time: { created: index + 1 },
        },
        parts,
      } as MessagesTransformEnvelope;
    }),
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

function summarizeProjectionDebugState(
  projection: ProjectedMessageSet,
): MessagesTransformProjectionDebugState {
  const projectedMessageSourceCounts = projection.messages.reduce(
    (counts, message) => {
      if (message.source === "canonical") {
        counts.canonical += 1;
      } else if (message.source === "result-group") {
        counts.resultGroup += 1;
      } else if (message.source === "reminder") {
        counts.reminder += 1;
      } else if (message.source === "synthetic") {
        counts.synthetic += 1;
      }

      return counts;
    },
    {
      canonical: 0,
      resultGroup: 0,
      reminder: 0,
      synthetic: 0,
    },
  );

  const visibleKindCounts = projection.messages.reduce(
    (counts, message) => {
      if (message.visibleKind === "protected") {
        counts.protected += 1;
      } else if (message.visibleKind === "compressible") {
        counts.compressible += 1;
      } else if (message.visibleKind === "referable") {
        counts.referable += 1;
      }

      return counts;
    },
    {
      protected: 0,
      compressible: 0,
      referable: 0,
    },
  );

  const totalCompressibleTokenCount = projection.state.messagePolicies.reduce(
    (total, policy) =>
      policy.visibleKind === "compressible" ? total + policy.tokenCount : total,
    0,
  );

  const resultGroupsByMarkId = new Map(
    projection.state.resultGroups.map((group) => [group.markId, group]),
  );
  const tokenCountBySequence = new Map(
    projection.state.messagePolicies.map((policy) => [policy.sequence, policy.tokenCount]),
  );
  const compressionMarkToolCalls = projection.state.history.compressionMarkToolCalls.map(call => {
    if (call.outcome === "accepted" && projection.state.failedToolMessageIds.has(call.sourceMessageId)) {
      const failure = projection.state.failedToolMessageIds.get(call.sourceMessageId)!;
      return {
        ...call,
        outcome: "rejected" as const,
        errorCode: failure.errorCode,
      };
    }
    return call;
  });

  return Object.freeze({
    canonicalMessageCount: projection.state.history.messages.length,
    projectedMessageCount: projection.messages.length,
    projectedMessageSourceCounts: Object.freeze(projectedMessageSourceCounts),
    visibleKindCounts: Object.freeze(visibleKindCounts),
    totalCompressibleTokenCount,
    uncompressedMarkedTokenCount: sumUncompressedMarkedTokens(
      projection.state.markTree.marks,
      resultGroupsByMarkId,
      tokenCountBySequence,
    ),
    compressionMarkToolCalls: Object.freeze({
      total: compressionMarkToolCalls.length,
      accepted: compressionMarkToolCalls.filter((call) => call.outcome === "accepted")
        .length,
      rejected: compressionMarkToolCalls.filter((call) => call.outcome === "rejected")
        .length,
      invalidInput: compressionMarkToolCalls.filter(
        (call) => call.outcome === "invalid-input",
      ).length,
      invalidResult: compressionMarkToolCalls.filter(
        (call) => call.outcome === "invalid-result",
      ).length,
      compact: compressionMarkToolCalls.filter((call) => call.mode === "compact").length,
      delete: compressionMarkToolCalls.filter((call) => call.mode === "delete").length,
      recent: Object.freeze(
        compressionMarkToolCalls.slice(-5).map((call) =>
          Object.freeze({
            sequence: call.sequence,
            sourceMessageId: call.sourceMessageId,
            outcome: call.outcome,
            mode: call.mode,
            errorCode: call.errorCode,
          }),
        ),
      ),
    }),
    replayedMarkIntents: Object.freeze({
      total: projection.state.history.marks.length,
      compact: projection.state.history.marks.filter((mark) => mark.mode === "compact")
        .length,
      delete: projection.state.history.marks.filter((mark) => mark.mode === "delete")
        .length,
      ids: Object.freeze(projection.state.history.marks.map((mark) => mark.markId)),
    }),
    activeMarkTree: Object.freeze({
      topLevelCount: projection.state.markTree.marks.length,
      totalNodeCount: countMarkNodes(projection.state.markTree.marks),
      ids: Object.freeze(flattenMarkIds(projection.state.markTree.marks)),
    }),
    conflicts: Object.freeze({
      count: projection.conflicts.length,
      messages: Object.freeze(projection.conflicts.map((conflict) => conflict.message)),
    }),
    resultGroups: Object.freeze({
      count: projection.state.resultGroups.length,
      fragmentCount: projection.state.resultGroups.reduce(
        (total, group) => total + group.fragmentCount,
        0,
      ),
      markIds: Object.freeze(projection.state.resultGroups.map((group) => group.markId)),
    }),
    reminders: Object.freeze({
      count: projection.reminders.length,
      kinds: Object.freeze(projection.reminders.map((reminder) => reminder.kind)),
    }),
  });
}

function countMarkNodes(
  marks: ProjectedMessageSet["state"]["markTree"]["marks"],
): number {
  return marks.reduce((total, mark) => total + 1 + countMarkNodes(mark.children), 0);
}

function flattenMarkIds(
  marks: ProjectedMessageSet["state"]["markTree"]["marks"],
): string[] {
  return marks.flatMap((mark) => [mark.markId, ...flattenMarkIds(mark.children)]);
}

function sumUncompressedMarkedTokens(
  marks: ProjectedMessageSet["state"]["markTree"]["marks"],
  resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>,
  tokenCountBySequence: ReadonlyMap<number, number>,
): number {
  return marks.reduce(
    (total, node) =>
      total + countUncompressedTokens(node, resultGroupsByMarkId, tokenCountBySequence),
    0,
  );
}

function countUncompressedTokens(
  node: ProjectedMessageSet["state"]["markTree"]["marks"][number],
  resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>,
  tokenCountBySequence: ReadonlyMap<number, number>,
): number {
  if (resultGroupsByMarkId.has(node.markId)) {
    return 0;
  }

  const ownRangeTokens = sumRangeTokens(
    node.startSequence,
    node.endSequence,
    tokenCountBySequence,
  );
  const childCompressedTokens = node.children.reduce(
    (total, child) =>
      total + countCompressedTokens(child, resultGroupsByMarkId, tokenCountBySequence),
    0,
  );

  return Math.max(0, ownRangeTokens - childCompressedTokens);
}

function countCompressedTokens(
  node: ProjectedMessageSet["state"]["markTree"]["marks"][number],
  resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>,
  tokenCountBySequence: ReadonlyMap<number, number>,
): number {
  if (resultGroupsByMarkId.has(node.markId)) {
    return sumRangeTokens(node.startSequence, node.endSequence, tokenCountBySequence);
  }

  return node.children.reduce(
    (total, child) =>
      total + countCompressedTokens(child, resultGroupsByMarkId, tokenCountBySequence),
    0,
  );
}

function sumRangeTokens(
  startSequence: number,
  endSequence: number,
  tokenCountBySequence: ReadonlyMap<number, number>,
): number {
  let total = 0;

  for (let sequence = startSequence; sequence <= endSequence; sequence += 1) {
    total += tokenCountBySequence.get(sequence) ?? 0;
  }

  return total;
}
