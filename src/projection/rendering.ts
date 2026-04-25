import { buildStableVisibleId, prependVisibleId, prependVisibleIdRange } from "../identity/visible-sequence.js";
import type { ReplayedHistory, ReplayedHistoryMessage } from "../history/history-replay-reader.js";
import type { CompleteResultGroup } from "../state/result-group-repository.js";
import type {
  MarkTree,
  MarkTreeNode,
  MessageProjectionPolicy,
  ProjectedPromptMessage,
  ToolMessageFailure,
} from "./types.js";

export interface RenderProjectionInput {
  readonly history: ReplayedHistory;
  readonly messagePolicies: readonly MessageProjectionPolicy[];
  readonly markTree: MarkTree;
  readonly resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>;
  readonly failedToolMessageIds: ReadonlyMap<string, ToolMessageFailure>;
}

export interface RenderProjectionOutput {
  readonly messages: readonly ProjectedPromptMessage[];
  readonly suppressedCanonicalIds: ReadonlySet<string>;
}

export function renderProjectionMessages(
  input: RenderProjectionInput,
): RenderProjectionOutput {
  const historyBySequence = new Map(
    input.history.messages.map((message) => [message.sequence, message]),
  );
  const policiesBySequence = new Map(
    input.messagePolicies.map((policy) => [policy.sequence, policy]),
  );
  const suppressedCanonicalIds = new Set<string>();
  const renderedMessages = renderSequenceRange({
    startSequence: input.history.messages[0]?.sequence ?? 1,
    endSequence: input.history.messages.at(-1)?.sequence ?? 0,
    children: input.markTree.marks,
    historyBySequence,
    policiesBySequence,
    resultGroupsByMarkId: input.resultGroupsByMarkId,
    suppressedCanonicalIds,
    failedToolMessageIds: input.failedToolMessageIds,
  }).filter(
    (message) =>
      message.source !== "canonical" ||
      message.canonicalId === undefined ||
      !suppressedCanonicalIds.has(message.canonicalId),
  );

  return Object.freeze({
    messages: Object.freeze(renderedMessages),
    suppressedCanonicalIds,
  } satisfies RenderProjectionOutput);
}

interface RenderSequenceRangeInput {
  readonly startSequence: number;
  readonly endSequence: number;
  readonly children: readonly MarkTreeNode[];
  readonly historyBySequence: ReadonlyMap<number, ReplayedHistoryMessage>;
  readonly policiesBySequence: ReadonlyMap<number, MessageProjectionPolicy>;
  readonly resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>;
  readonly suppressedCanonicalIds: Set<string>;
  readonly failedToolMessageIds: ReadonlyMap<string, ToolMessageFailure>;
}

function renderSequenceRange(
  input: RenderSequenceRangeInput,
): ProjectedPromptMessage[] {
  if (input.endSequence < input.startSequence) {
    return [];
  }

  const rendered: ProjectedPromptMessage[] = [];
  let cursor = input.startSequence;

  [...input.children]
    .sort((left, right) => left.startSequence - right.startSequence)
    .forEach((child) => {
      rendered.push(
        ...renderOriginalRange({
          startSequence: cursor,
          endSequence: child.startSequence - 1,
          historyBySequence: input.historyBySequence,
          policiesBySequence: input.policiesBySequence,
          failedToolMessageIds: input.failedToolMessageIds,
        }),
      );
      rendered.push(
        ...renderMarkNode({
          node: child,
          historyBySequence: input.historyBySequence,
          policiesBySequence: input.policiesBySequence,
          resultGroupsByMarkId: input.resultGroupsByMarkId,
          suppressedCanonicalIds: input.suppressedCanonicalIds,
          failedToolMessageIds: input.failedToolMessageIds,
        }),
      );
      cursor = child.endSequence + 1;
    });

  rendered.push(
    ...renderOriginalRange({
      startSequence: cursor,
      endSequence: input.endSequence,
      historyBySequence: input.historyBySequence,
      policiesBySequence: input.policiesBySequence,
      failedToolMessageIds: input.failedToolMessageIds,
    }),
  );

  return rendered;
}

function renderMarkNode(input: {
  readonly node: MarkTreeNode;
  readonly historyBySequence: ReadonlyMap<number, ReplayedHistoryMessage>;
  readonly policiesBySequence: ReadonlyMap<number, MessageProjectionPolicy>;
  readonly resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>;
  readonly suppressedCanonicalIds: Set<string>;
  readonly failedToolMessageIds: ReadonlyMap<string, ToolMessageFailure>;
}): ProjectedPromptMessage[] {
  const resultGroup = input.resultGroupsByMarkId.get(input.node.markId);
  if (!resultGroup) {
    return renderSequenceRange({
      startSequence: input.node.startSequence,
      endSequence: input.node.endSequence,
      children: input.node.children,
      historyBySequence: input.historyBySequence,
      policiesBySequence: input.policiesBySequence,
      resultGroupsByMarkId: input.resultGroupsByMarkId,
      suppressedCanonicalIds: input.suppressedCanonicalIds,
      failedToolMessageIds: input.failedToolMessageIds,
      });
  }

  collectSuppressedCanonicalIds({
    node: input.node,
    resultGroup,
    historyBySequence: input.historyBySequence,
    suppressedCanonicalIds: input.suppressedCanonicalIds,
  });

  const rendered: ProjectedPromptMessage[] = [];
  let cursor = input.node.startSequence;

  resultGroup.fragments.forEach((fragment) => {
    rendered.push(
      ...renderGapRange({
        startSequence: cursor,
        endSequence: fragment.sourceStartSeq - 1,
        children: input.node.children,
        historyBySequence: input.historyBySequence,
        policiesBySequence: input.policiesBySequence,
        resultGroupsByMarkId: input.resultGroupsByMarkId,
        suppressedCanonicalIds: input.suppressedCanonicalIds,
        failedToolMessageIds: input.failedToolMessageIds,
      }),
    );
    rendered.push(renderResultGroupFragment(resultGroup, fragment));
    cursor = fragment.sourceEndSeq + 1;
  });

  rendered.push(
    ...renderGapRange({
      startSequence: cursor,
      endSequence: input.node.endSequence,
      children: input.node.children,
      historyBySequence: input.historyBySequence,
      policiesBySequence: input.policiesBySequence,
      resultGroupsByMarkId: input.resultGroupsByMarkId,
      suppressedCanonicalIds: input.suppressedCanonicalIds,
      failedToolMessageIds: input.failedToolMessageIds,
    }),
  );

  return rendered;
}

function renderResultGroupFragment(
  resultGroup: CompleteResultGroup,
  fragment: CompleteResultGroup["fragments"][number],
): ProjectedPromptMessage {
  if (resultGroup.mode === "delete") {
    return Object.freeze({
      source: "result-group",
      role: "assistant",
      sourceMarkId: resultGroup.markId,
      contentText: fragment.replacementText,
      parts: createCompressedReasoningParts(),
    } satisfies ProjectedPromptMessage);
  }

  const stableKey = `${resultGroup.markId}:${fragment.fragmentIndex}`;
  const visibleId = buildStableVisibleId(
    "referable",
    fragment.sourceStartSeq,
    stableKey,
  );
  const contentText = prependVisibleIdRange(
    fragment.sourceStartSeq,
    fragment.sourceEndSeq,
    stableKey,
    fragment.replacementText,
  );

  return Object.freeze({
    source: "result-group",
    role: "assistant",
    sourceMarkId: resultGroup.markId,
    visibleKind: "referable",
    visibleId,
    contentText,
    parts: createCompressedReasoningParts(),
  } satisfies ProjectedPromptMessage);
}

function createCompressedReasoningParts(): ProjectedPromptMessage["parts"] {
  return Object.freeze([
    Object.freeze({
      type: "reasoning" as const,
      text: "compressed",
    }),
  ]);
}

function renderOriginalRange(input: {
  readonly startSequence: number;
  readonly endSequence: number;
  readonly historyBySequence: ReadonlyMap<number, ReplayedHistoryMessage>;
  readonly policiesBySequence: ReadonlyMap<number, MessageProjectionPolicy>;
  readonly failedToolMessageIds: ReadonlyMap<string, ToolMessageFailure>;
}): ProjectedPromptMessage[] {
  const rendered: ProjectedPromptMessage[] = [];

  for (let sequence = input.startSequence; sequence <= input.endSequence; sequence += 1) {
    const message = input.historyBySequence.get(sequence);
    const policy = input.policiesBySequence.get(sequence);
    if (!message || !policy) {
      continue;
    }

    let parts = message.parts;
    let hostMessage = message.hostMessage;
    
    const failure = input.failedToolMessageIds.get(message.canonicalId);
    const failureOutput = failure ? stringifyToolMessageFailure(failure) : undefined;
    if (failure) {
      parts = message.parts.map(part => {
        if (part.type === "tool" && part.tool === "compression_mark") {
          const state = part.state as any;
          return {
            ...part,
            state: {
              ...state,
              status: "completed",
              output: failureOutput,
            },
          };
        }
        return part;
      });
      
      hostMessage = {
        ...message.hostMessage,
        parts,
      };
    }

    rendered.push(
      Object.freeze({
        source: "canonical",
        role: message.role,
        canonicalId: message.canonicalId,
        visibleKind: policy.visibleKind,
        visibleId: policy.visibleId,
        // Preserve trailing empty assistant placeholders from the host without surfacing a visible-id-only text shell.
        contentText:
          failure
            ? prependVisibleId(policy.visibleId, failureOutput!)
            : message.contentText.trim().length === 0
              ? ""
              : prependVisibleId(policy.visibleId, message.contentText),
        parts,
        hostMessage,
      } satisfies ProjectedPromptMessage),
    );
  }

  return rendered;
}

function stringifyToolMessageFailure(failure: ToolMessageFailure): string {
  return JSON.stringify({
    ok: false,
    errorCode: failure.errorCode,
    message: failure.message,
  });
}

function collectSuppressedCanonicalIds(
  input: {
    readonly node: MarkTreeNode;
    readonly resultGroup: CompleteResultGroup;
    readonly historyBySequence: ReadonlyMap<number, ReplayedHistoryMessage>;
    readonly suppressedCanonicalIds: Set<string>;
  },
): void {
  input.suppressedCanonicalIds.add(input.node.sourceMessageId);
  input.node.children.forEach((child) => {
    collectSuppressedCanonicalIds({
      node: child,
      resultGroup: input.resultGroup,
      historyBySequence: input.historyBySequence,
      suppressedCanonicalIds: input.suppressedCanonicalIds,
    });
  });

  input.resultGroup.fragments.forEach((fragment) => {
    for (
      let sequence = fragment.sourceStartSeq;
      sequence <= fragment.sourceEndSeq;
      sequence += 1
    ) {
      const message = input.historyBySequence.get(sequence);
      if (message) {
        input.suppressedCanonicalIds.add(message.canonicalId);
      }
    }
  });
}

function renderGapRange(input: {
  readonly startSequence: number;
  readonly endSequence: number;
  readonly children: readonly MarkTreeNode[];
  readonly historyBySequence: ReadonlyMap<number, ReplayedHistoryMessage>;
  readonly policiesBySequence: ReadonlyMap<number, MessageProjectionPolicy>;
  readonly resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>;
  readonly suppressedCanonicalIds: Set<string>;
  readonly failedToolMessageIds: ReadonlyMap<string, ToolMessageFailure>;
}): ProjectedPromptMessage[] {
  if (input.endSequence < input.startSequence) {
    return [];
  }

  return renderSequenceRange({
    startSequence: input.startSequence,
    endSequence: input.endSequence,
    children: input.children.filter(
      (child) =>
        child.startSequence <= input.endSequence &&
        child.endSequence >= input.startSequence,
    ),
    historyBySequence: input.historyBySequence,
    policiesBySequence: input.policiesBySequence,
    resultGroupsByMarkId: input.resultGroupsByMarkId,
    suppressedCanonicalIds: input.suppressedCanonicalIds,
    failedToolMessageIds: input.failedToolMessageIds,
  });
}
