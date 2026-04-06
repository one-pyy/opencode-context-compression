import { defineInternalModuleContract } from "../internal/module-contract.js";
import type { ReplayedHistory } from "../history/history-replay-reader.js";
import type { ConflictRecord, MarkTree, MarkTreeNode } from "./types.js";

export interface PolicyEngine {
  buildMarkTree(history: ReplayedHistory): MarkTree;
  detectConflicts(tree: MarkTree): readonly ConflictRecord[];
}

export const POLICY_ENGINE_INTERNAL_CONTRACT = defineInternalModuleContract({
  module: "PolicyEngine",
  inputs: ["ReplayedHistory", "MarkTree"],
  outputs: ["MarkTree", "ConflictRecord[]"],
  mutability: "read-only",
  reads: ["replayed canonical messages", "replayed mark intents"],
  writes: [],
  errorTypes: ["OVERLAP_CONFLICT"],
  idempotency:
    "Pure and deterministic for the same replayed history and mark ordering.",
  dependencyDirection: {
    inboundFrom: ["ProjectionBuilder"],
    outboundTo: [],
  },
});

export function createFlatPolicyEngine(): PolicyEngine {
  return {
    buildMarkTree(history) {
      return {
        marks: history.marks.map(
          (mark) =>
            ({
              markId: mark.markId,
              mode: mark.mode,
              startVisibleMessageId: mark.startVisibleMessageId,
              endVisibleMessageId: mark.endVisibleMessageId,
              sourceMessageId: mark.sourceMessageId,
              depth: 0,
              children: Object.freeze([]),
            } satisfies MarkTreeNode),
        ),
      } satisfies MarkTree;
    },
    detectConflicts() {
      return Object.freeze([]);
    },
  } satisfies PolicyEngine;
}
