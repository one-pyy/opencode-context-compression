import { parseVisibleId } from "../identity/visible-sequence.js";
import {
  createCompressionInspectFailure,
  serializeCompressionInspectResult,
  type CompressionInspectMessageTokenInfo,
} from "../tools/compression-inspect.js";
import type { CompleteResultGroup } from "../state/result-group-repository.js";
import type {
  MarkTreeNode,
  MessageProjectionPolicy,
  ProjectionState,
  ToolResultOverride,
} from "./types.js";

export function buildCompressionInspectOverrides(
  state: ProjectionState,
): readonly ToolResultOverride[] {
  const resultGroupsByMarkId = new Map(
    state.resultGroups.map((group) => [group.markId, group]),
  );
  const coveredSequences = collectCoveredSequences(
    state.markTree.marks,
    resultGroupsByMarkId,
  );

  return Object.freeze(
    (state.history.compressionInspectToolCalls ?? []).flatMap((call) => {
      if (
        call.outcome !== "accepted" ||
        call.startVisibleMessageId === undefined ||
        call.endVisibleMessageId === undefined
      ) {
        return [];
      }

      let output: string;
      try {
        const messages = inspectMessagesInRange({
          policies: state.messagePolicies,
          from: call.startVisibleMessageId,
          to: call.endVisibleMessageId,
          coveredSequences,
        });
        output = serializeCompressionInspectResult({ ok: true, messages });
      } catch (error) {
        output = serializeCompressionInspectResult(
          createCompressionInspectFailure(
            "INVALID_RANGE",
            error instanceof Error
              ? error.message
              : "compression_inspect could not resolve the requested range.",
            {
              from: call.startVisibleMessageId,
              to: call.endVisibleMessageId,
            },
          ),
        );
      }

      return [
        Object.freeze({
          sourceMessageId: call.sourceMessageId,
          toolName: "compression_inspect",
          output,
        } satisfies ToolResultOverride),
      ];
    }),
  );
}

export function inspectMessagesInRange(input: {
  readonly policies: readonly MessageProjectionPolicy[];
  readonly from: string;
  readonly to: string;
  readonly coveredSequences: ReadonlySet<number>;
}): readonly CompressionInspectMessageTokenInfo[] {
  const range = parseInclusiveVisibleRange(input.policies, input.from, input.to);
  return Object.freeze(
    input.policies
      .filter(
        (policy) =>
          policy.visibleSeq >= range.startVisibleSeq &&
          policy.visibleSeq <= range.endVisibleSeq &&
          policy.visibleKind === "compressible" &&
          !input.coveredSequences.has(policy.sequence),
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map((policy) =>
        Object.freeze({
          id: policy.visibleId,
          tokens: policy.tokenCount,
        } satisfies CompressionInspectMessageTokenInfo),
      ),
  );
}

function parseInclusiveVisibleRange(
  policies: readonly MessageProjectionPolicy[],
  from: string,
  to: string,
): { readonly startVisibleSeq: number; readonly endVisibleSeq: number } {
  const visibleSeqByKey = new Map(
    policies.map((policy) => [
      toVisibleIdLookupKey(policy.visibleId),
      policy.visibleSeq,
    ]),
  );
  const startVisibleSeq = visibleSeqByKey.get(toVisibleIdLookupKey(from));
  const endVisibleSeq = visibleSeqByKey.get(toVisibleIdLookupKey(to));
  if (startVisibleSeq === undefined || endVisibleSeq === undefined) {
    throw new Error("compression_inspect targets an unknown visible-id range.");
  }
  if (startVisibleSeq > endVisibleSeq) {
    throw new Error("compression_inspect from/to range is reversed.");
  }

  return { startVisibleSeq, endVisibleSeq };
}

function toVisibleIdLookupKey(visibleId: string): string {
  const parsed = parseVisibleId(visibleId);
  return `${String(parsed.visibleSeq).padStart(6, "0")}_${parsed.suffix}`;
}

function collectCoveredSequences(
  marks: readonly MarkTreeNode[],
  resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>,
): ReadonlySet<number> {
  const covered = new Set<number>();
  collectCoveredSequencesInto(marks, resultGroupsByMarkId, covered);
  return covered;
}

function collectCoveredSequencesInto(
  marks: readonly MarkTreeNode[],
  resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>,
  covered: Set<number>,
): void {
  marks.forEach((mark) => {
    const resultGroup = resultGroupsByMarkId.get(mark.markId);
    if (resultGroup) {
      resultGroup.fragments.forEach((fragment) => {
        for (
          let sequence = fragment.sourceStartSeq;
          sequence <= fragment.sourceEndSeq;
          sequence += 1
        ) {
          covered.add(sequence);
        }
      });
    }

    collectCoveredSequencesInto(mark.children, resultGroupsByMarkId, covered);
  });
}
