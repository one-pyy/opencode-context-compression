import { defineInternalModuleContract } from "../internal/module-contract.js";
import {
  buildReferableMarkerIds,
  parseVisibleId,
} from "../identity/visible-sequence.js";
import type { ReplayedHistory } from "../history/history-replay-reader.js";
import type { CompleteResultGroup } from "../state/result-group-repository.js";
import type { TransformEnvelope } from "../seams/noop-observation.js";
import { estimateEnvelopeTokensWithService } from "../token-estimation.js";
import type {
  ConflictRecord,
  MarkTree,
  MarkTreeNode,
  MessageProjectionPolicySeed,
} from "./types.js";

interface BuildMarkTreeInput {
  readonly history: ReplayedHistory;
  readonly visibleIdsByCanonicalId: ReadonlyMap<string, string>;
  readonly resultGroups: readonly CompleteResultGroup[];
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
  classifyMessages(history: ReplayedHistory): Promise<readonly MessageProjectionPolicySeed[]>;
  buildMarkTree(input: BuildMarkTreeInput): MarkTree;
  detectConflicts(tree: MarkTree): readonly ConflictRecord[];
}

export const POLICY_ENGINE_INTERNAL_CONTRACT = defineInternalModuleContract({
  module: "PolicyEngine",
  inputs: ["ReplayedHistory", "visible-id lookup", "result groups", "MarkTree"],
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
    async classifyMessages(history) {
      const policies = await Promise.all(
        history.messages.map(async (message) =>
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
                ? (await estimateEnvelopeTokensWithService({
                    envelope: message.hostMessage as TransformEnvelope,
                    modelName: options.modelName,
                  })).tokenCount
                : 0,
          } satisfies MessageProjectionPolicySeed),
        ),
      );

      return Object.freeze(policies);
    },
    buildMarkTree(input) {
      const marks = [...input.history.marks].sort(
        (left, right) => left.sourceSequence - right.sourceSequence,
      );
      const visibleSequences = new Map<string, number>();
      const visibleIdBySequence = new Map<number, string>();
      const conflicts: ConflictRecord[] = [];
      const roots: MutableMarkTreeNode[] = [];

      input.history.messages.forEach((message) => {
        const visibleId = input.visibleIdsByCanonicalId.get(message.canonicalId);
        if (visibleId) {
          visibleSequences.set(toVisibleIdLookupKey(visibleId), message.sequence);
          visibleIdBySequence.set(message.sequence, visibleId);
        }
      });

      // Referable markers are rendered per result fragment, so resolution
      // compares the exact marker id: stale or fabricated markers fail, and a
      // marker claimed by two different sequences is rejected as ambiguous.
      const referableSequences = new Map<string, number>();
      const ambiguousReferableIds = new Set<string>();
      const registerReferableMarker = (markerId: string, sequence: number): void => {
        const existing = referableSequences.get(markerId);
        if (existing !== undefined && existing !== sequence) {
          ambiguousReferableIds.add(markerId);
          return;
        }

        referableSequences.set(markerId, sequence);
      };

      input.resultGroups.forEach((group) => {
        if (group.mode === "delete") {
          return;
        }

        group.fragments.forEach((fragment) => {
          const markers = buildReferableMarkerIds({
            markId: group.markId,
            fragmentIndex: fragment.fragmentIndex,
            sourceStartSeq: fragment.sourceStartSeq,
            sourceEndSeq: fragment.sourceEndSeq,
          });
          registerReferableMarker(markers.startId, fragment.sourceStartSeq);
          registerReferableMarker(markers.endId, fragment.sourceEndSeq);
        });
      });

      // Host endpoints resolve by seq6 + checksum; referable markers resolve
      // only when they match exactly one current result fragment.
      const resolveEndpoint = (
        visibleId: string,
      ): { readonly sequence: number; readonly hostVisibleId: string } | undefined => {
        const hostSequence = visibleSequences.get(toVisibleIdLookupKey(visibleId));
        if (hostSequence !== undefined) {
          return {
            sequence: hostSequence,
            hostVisibleId: visibleIdBySequence.get(hostSequence) ?? visibleId,
          };
        }

        const parsed = parseVisibleId(visibleId);
        if (parsed.kind !== "referable" || ambiguousReferableIds.has(visibleId)) {
          return undefined;
        }

        const referableSequence = referableSequences.get(visibleId);
        if (referableSequence === undefined) {
          return undefined;
        }

        const hostVisibleId = visibleIdBySequence.get(referableSequence);
        return hostVisibleId === undefined
          ? undefined
          : { sequence: referableSequence, hostVisibleId };
      };

      marks.forEach((mark) => {
        const start = resolveEndpoint(mark.startVisibleMessageId);
        const end = resolveEndpoint(mark.endVisibleMessageId);
        if (
          start === undefined ||
          end === undefined ||
          start.sequence > end.sequence
        ) {
          conflicts.push(
            createConflict(
              mark.markId,
              `Mark '${mark.markId}' targets an unknown or reversed visible-id range and is excluded from the coverage tree. Mark endpoints must resolve to a host message or to a referable range marker of a current compression result.`,
            ),
          );
          return;
        }

        const mutableNode: MutableMarkTreeNode = {
          markId: mark.markId,
          mode: mark.mode,
          startVisibleMessageId: start.hostVisibleId,
          endVisibleMessageId: end.hostVisibleId,
          sourceMessageId: mark.sourceMessageId,
          sourceSequence: mark.sourceSequence,
          startSequence: start.sequence,
          endSequence: end.sequence,
          children: [],
          hint: mark.hint,
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

function toVisibleIdLookupKey(visibleId: string): string {
  const parsed = parseVisibleId(visibleId);
  return `${String(parsed.visibleSeq).padStart(6, "0")}_${parsed.suffix}`;
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

    // Delete marks must stay at the root; reject the later mark before mutating the tree.
    if ((relation === "contains" || relation === "equal") && sibling.mode === "delete") {
      return `Mark '${nextNode.markId}' contains delete mark '${sibling.markId}' and is excluded from the coverage tree. Delete marks cannot be contained by another mark.`;
    }
    if (relation === "inside" && nextNode.mode === "delete") {
      return `Delete mark '${nextNode.markId}' is inside mark '${sibling.markId}' and is excluded from the coverage tree. Delete marks cannot be contained by another mark.`;
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
