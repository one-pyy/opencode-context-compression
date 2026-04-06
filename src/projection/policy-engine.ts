import { defineInternalModuleContract } from "../internal/module-contract.js";
import type { ReplayedHistory } from "../history/history-replay-reader.js";
import type { TransformEnvelope } from "../seams/noop-observation.js";
import { estimateEnvelopeTokens } from "../token-estimation.js";
import type {
  ConflictRecord,
  MarkTree,
  MarkTreeNode,
  MessageProjectionPolicySeed,
} from "./types.js";

interface BuildMarkTreeInput {
  readonly history: ReplayedHistory;
  readonly visibleIdsByCanonicalId: ReadonlyMap<string, string>;
}

interface MutableMarkTreeNode
  extends Omit<MarkTreeNode, "children" | "depth"> {
  children: MutableMarkTreeNode[];
}

type RangeRelation =
  | "disjoint"
  | "equal"
  | "inside"
  | "contains"
  | "partial";

export interface PolicyEngine {
  classifyMessages(history: ReplayedHistory): readonly MessageProjectionPolicySeed[];
  buildMarkTree(input: BuildMarkTreeInput): MarkTree;
  detectConflicts(tree: MarkTree): readonly ConflictRecord[];
}

export const POLICY_ENGINE_INTERNAL_CONTRACT = defineInternalModuleContract({
  module: "PolicyEngine",
  inputs: ["ReplayedHistory", "visible-id lookup", "MarkTree"],
  outputs: ["MessageProjectionPolicySeed[]", "MarkTree", "ConflictRecord[]"],
  mutability: "read-only",
  reads: ["replayed canonical messages", "replayed mark intents", "token estimation"],
  writes: [],
  errorTypes: ["OVERLAP_CONFLICT"],
  idempotency:
    "Pure and deterministic for the same replayed history and mark ordering.",
  dependencyDirection: {
    inboundFrom: ["ProjectionBuilder"],
    outboundTo: [],
  },
});

export interface DesignPolicyEngineOptions {
  readonly smallUserMessageThreshold?: number;
  readonly modelName?: string;
}

export function createFlatPolicyEngine(
  options: DesignPolicyEngineOptions = {},
): PolicyEngine {
  const smallUserMessageThreshold = options.smallUserMessageThreshold ?? 1_024;

  return {
    classifyMessages(history) {
      return Object.freeze(
        history.messages.map((message) =>
          Object.freeze({
            canonicalId: message.canonicalId,
            sequence: message.sequence,
            role: message.role,
            visibleKind: classifyVisibleKind(
              message.role,
              message.contentText,
              smallUserMessageThreshold,
            ),
            tokenCount:
              message.role === "assistant" ||
              message.role === "tool" ||
              (message.role === "user" &&
                message.contentText.length > smallUserMessageThreshold)
                ? estimateEnvelopeTokens({
                    envelope: message.hostMessage as TransformEnvelope,
                    modelName: options.modelName,
                  }).tokenCount
                : 0,
          } satisfies MessageProjectionPolicySeed),
        ),
      );
    },
    buildMarkTree(input) {
      const marks = [...input.history.marks].sort(
        (left, right) => left.sourceSequence - right.sourceSequence,
      );
      const visibleSequences = new Map<string, number>();
      const conflicts: ConflictRecord[] = [];
      const roots: MutableMarkTreeNode[] = [];

      input.history.messages.forEach((message) => {
        const visibleId = input.visibleIdsByCanonicalId.get(message.canonicalId);
        if (visibleId) {
          visibleSequences.set(visibleId, message.sequence);
        }
      });

      marks.forEach((mark) => {
        const startSequence = visibleSequences.get(mark.startVisibleMessageId);
        const endSequence = visibleSequences.get(mark.endVisibleMessageId);
        if (
          startSequence === undefined ||
          endSequence === undefined ||
          startSequence > endSequence
        ) {
          conflicts.push(
            createConflict(
              mark.markId,
              `Mark '${mark.markId}' targets an unknown or reversed visible-id range and is excluded from the coverage tree.`,
            ),
          );
          return;
        }

        const mutableNode: MutableMarkTreeNode = {
          markId: mark.markId,
          mode: mark.mode,
          startVisibleMessageId: mark.startVisibleMessageId,
          endVisibleMessageId: mark.endVisibleMessageId,
          sourceMessageId: mark.sourceMessageId,
          sourceSequence: mark.sourceSequence,
          startSequence,
          endSequence,
          children: [],
        };
        const conflict = insertMarkTreeNode(roots, mutableNode);
        if (conflict) {
          conflicts.push(createConflict(mark.markId, conflict));
        }
      });

      return Object.freeze({
        marks: Object.freeze(roots.map((node) => freezeMarkTreeNode(node, 0))),
        conflicts: Object.freeze(conflicts),
      } satisfies MarkTree);
    },
    detectConflicts(tree) {
      return tree.conflicts;
    },
  } satisfies PolicyEngine;
}

function classifyVisibleKind(
  role: "system" | "user" | "assistant" | "tool",
  contentText: string,
  smallUserMessageThreshold: number,
): "protected" | "compressible" {
  if (role === "system") {
    return "protected";
  }

  if (role === "user" && contentText.length <= smallUserMessageThreshold) {
    return "protected";
  }

  return "compressible";
}

function insertMarkTreeNode(
  siblings: MutableMarkTreeNode[],
  nextNode: MutableMarkTreeNode,
): string | null {
  let container: MutableMarkTreeNode | undefined;

  for (const sibling of siblings) {
    const relation = compareRanges(nextNode, sibling);
    if (relation === "partial") {
      return `Mark '${nextNode.markId}' partially overlaps '${sibling.markId}' without containment.`;
    }

    if (relation === "inside") {
      if (
        container === undefined ||
        measureRange(sibling) < measureRange(container)
      ) {
        container = sibling;
      }
    }
  }

  if (container) {
    return insertMarkTreeNode(container.children, nextNode);
  }

  const adoptedChildren = siblings.filter((sibling) => {
    const relation = compareRanges(nextNode, sibling);
    return relation === "contains" || relation === "equal";
  });
  if (adoptedChildren.length > 0) {
    nextNode.children.push(...adoptedChildren);
  }

  const remainingSiblings = siblings.filter(
    (sibling) => !adoptedChildren.includes(sibling),
  );
  remainingSiblings.push(nextNode);
  remainingSiblings.sort(compareNodesByRange);
  siblings.splice(0, siblings.length, ...remainingSiblings);
  return null;
}

function compareRanges(
  nextNode: Pick<MarkTreeNode, "startSequence" | "endSequence">,
  sibling: Pick<MarkTreeNode, "startSequence" | "endSequence">,
): RangeRelation {
  if (
    nextNode.endSequence < sibling.startSequence ||
    nextNode.startSequence > sibling.endSequence
  ) {
    return "disjoint";
  }

  if (
    nextNode.startSequence === sibling.startSequence &&
    nextNode.endSequence === sibling.endSequence
  ) {
    return "equal";
  }

  if (
    nextNode.startSequence >= sibling.startSequence &&
    nextNode.endSequence <= sibling.endSequence
  ) {
    return "inside";
  }

  if (
    nextNode.startSequence <= sibling.startSequence &&
    nextNode.endSequence >= sibling.endSequence
  ) {
    return "contains";
  }

  return "partial";
}

function freezeMarkTreeNode(
  node: MutableMarkTreeNode,
  depth: number,
): MarkTreeNode {
  return Object.freeze({
    markId: node.markId,
    mode: node.mode,
    startVisibleMessageId: node.startVisibleMessageId,
    endVisibleMessageId: node.endVisibleMessageId,
    sourceMessageId: node.sourceMessageId,
    sourceSequence: node.sourceSequence,
    startSequence: node.startSequence,
    endSequence: node.endSequence,
    depth,
    children: Object.freeze(
      [...node.children]
        .sort(compareNodesByRange)
        .map((child) => freezeMarkTreeNode(child, depth + 1)),
    ),
  } satisfies MarkTreeNode);
}

function compareNodesByRange(
  left: Pick<MarkTreeNode, "startSequence" | "endSequence" | "sourceSequence">,
  right: Pick<MarkTreeNode, "startSequence" | "endSequence" | "sourceSequence">,
): number {
  return (
    left.startSequence - right.startSequence ||
    right.endSequence - left.endSequence ||
    left.sourceSequence - right.sourceSequence
  );
}

function createConflict(markId: string, message: string): ConflictRecord {
  return Object.freeze({
    markId,
    errorCode: "OVERLAP_CONFLICT",
    message,
  } satisfies ConflictRecord);
}

function measureRange(node: Pick<MarkTreeNode, "startSequence" | "endSequence">): number {
  return node.endSequence - node.startSequence;
}
