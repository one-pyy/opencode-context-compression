import { buildStableVisibleId, prependVisibleId } from "../identity/visible-sequence.js";
import type { ReplayedHistory, ReplayedHistoryMessage } from "../history/history-replay-reader.js";
import type { CompleteResultGroup } from "../state/result-group-repository.js";
import type {
  MarkTree,
  MarkTreeNode,
  MessageProjectionPolicy,
  ProjectedPromptMessage,
} from "./types.js";

export interface RenderProjectionInput {
  readonly history: ReplayedHistory;
  readonly messagePolicies: readonly MessageProjectionPolicy[];
  readonly markTree: MarkTree;
  readonly resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>;
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
        }),
      );
      rendered.push(
        ...renderMarkNode({
          node: child,
          historyBySequence: input.historyBySequence,
          policiesBySequence: input.policiesBySequence,
          resultGroupsByMarkId: input.resultGroupsByMarkId,
          suppressedCanonicalIds: input.suppressedCanonicalIds,
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
    });
  }

  collectSuppressedCanonicalIds(input.node, input.suppressedCanonicalIds);

  const rendered: ProjectedPromptMessage[] = [];
  let cursor = input.node.startSequence;

  resultGroup.fragments.forEach((fragment) => {
    rendered.push(
      ...renderOriginalRange({
        startSequence: cursor,
        endSequence: fragment.sourceStartSeq - 1,
        historyBySequence: input.historyBySequence,
        policiesBySequence: input.policiesBySequence,
      }),
    );
    const visibleId = buildStableVisibleId(
      "referable",
      fragment.sourceStartSeq,
      `${resultGroup.markId}:${fragment.fragmentIndex}`,
    );
    rendered.push(
      Object.freeze({
        source: "result-group",
        role: "assistant",
        sourceMarkId: resultGroup.markId,
        visibleKind: "referable",
        visibleId,
        contentText: prependVisibleId(visibleId, fragment.replacementText),
      } satisfies ProjectedPromptMessage),
    );
    cursor = fragment.sourceEndSeq + 1;
  });

  rendered.push(
    ...renderOriginalRange({
      startSequence: cursor,
      endSequence: input.node.endSequence,
      historyBySequence: input.historyBySequence,
      policiesBySequence: input.policiesBySequence,
    }),
  );

  return rendered;
}

function renderOriginalRange(input: {
  readonly startSequence: number;
  readonly endSequence: number;
  readonly historyBySequence: ReadonlyMap<number, ReplayedHistoryMessage>;
  readonly policiesBySequence: ReadonlyMap<number, MessageProjectionPolicy>;
}): ProjectedPromptMessage[] {
  const rendered: ProjectedPromptMessage[] = [];

  for (let sequence = input.startSequence; sequence <= input.endSequence; sequence += 1) {
    const message = input.historyBySequence.get(sequence);
    const policy = input.policiesBySequence.get(sequence);
    if (!message || !policy) {
      continue;
    }

    rendered.push(
      Object.freeze({
        source: "canonical",
        role: message.role,
        canonicalId: message.canonicalId,
        visibleKind: policy.visibleKind,
        visibleId: policy.visibleId,
        contentText: prependVisibleId(policy.visibleId, message.contentText),
      } satisfies ProjectedPromptMessage),
    );
  }

  return rendered;
}

function collectSuppressedCanonicalIds(
  node: MarkTreeNode,
  suppressedCanonicalIds: Set<string>,
): void {
  suppressedCanonicalIds.add(node.sourceMessageId);
  node.children.forEach((child) => {
    collectSuppressedCanonicalIds(child, suppressedCanonicalIds);
  });
}
