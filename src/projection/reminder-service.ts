import { defineInternalModuleContract } from "../internal/module-contract.js";
import { buildStableVisibleId } from "../identity/visible-sequence.js";
import { buildCompressionInspectListing } from "./compression-inspect.js";
import type {
  ProjectedPromptMessage,
  ProjectionState,
  ReminderArtifact,
  ReminderKind,
} from "./types.js";

export interface ReminderComputationInput {
  readonly state: ProjectionState;
  readonly messages: readonly ProjectedPromptMessage[];
  readonly deletableTokenCount?: number;
}

export interface ReminderService {
  compute(input: ReminderComputationInput): readonly ReminderArtifact[];
}

export const REMINDER_SERVICE_INTERNAL_CONTRACT = defineInternalModuleContract({
  module: "ReminderService",
  inputs: ["ProjectionState", "ProjectedPromptMessage[]"],
  outputs: ["ReminderArtifact[]"],
  mutability: "read-only",
  reads: ["projection state", "policy-derived token totals and anchors", "reminder prompt text"],
  writes: [],
  errorTypes: [],
  idempotency: "Pure and deterministic for the same projection state.",
  dependencyDirection: {
    inboundFrom: ["ProjectionBuilder"],
    outboundTo: [],
  },
});

export function createStaticReminderService(
  reminders: readonly ReminderArtifact[] = Object.freeze([]),
): ReminderService {
  return {
    compute() {
      return reminders;
    },
  } satisfies ReminderService;
}

export interface ConfiguredReminderServiceOptions {
  readonly hsoft: number;
  readonly hhard: number;
  readonly hdelete?: number;
  readonly softRepeatEveryTokens: number;
  readonly hardRepeatEveryTokens: number;
  readonly allowDelete: boolean;
  readonly promptTextByKind: Readonly<Record<ReminderKind, string>>;
  readonly retirePromptText?: string;
}

export function createConfiguredReminderService(
  options: ConfiguredReminderServiceOptions,
): ReminderService {
  return {
    compute({ state, messages }) {
      const policiesByCanonicalId = new Map(
        state.messagePolicies.map((policy) => [policy.canonicalId, policy]),
      );
      const reminders: ReminderArtifact[] = [];
      let compressibleTokens = 0;
      let summaryTokens = 0;
      let nextSoft = options.hsoft;
      let nextHard = options.hhard;

      messages.forEach((message) => {
        if (message.source === "result-group" && message.visibleKind === "referable") {
          summaryTokens += message.visibleTokenCount ?? Math.ceil(message.contentText.length / 4);
        }
        if (message.source !== "canonical" || message.canonicalId === undefined) {
          return;
        }

        const policy = policiesByCanonicalId.get(message.canonicalId);
        if (policy?.visibleKind !== "compressible") {
          return;
        }

        compressibleTokens += policy.tokenCount;
        // Later summaries must not rewrite the reminder or inspect pair in an unchanged prefix.
        const retireSummaries = options.allowDelete && summaryTokens > (options.hdelete ?? 60_000);
        const inspectMode = retireSummaries ? "delete" : "compact";

        let selectedMilestone: number | undefined;
        let selectedKind: ReminderKind | undefined;

        while (true) {
          const softMilestone = nextSoft < options.hhard ? nextSoft : Number.POSITIVE_INFINITY;
          const hardMilestone = nextHard;
          const nextMilestone = Math.min(softMilestone, hardMilestone);
          if (compressibleTokens < nextMilestone) {
            break;
          }

          selectedMilestone = nextMilestone;
          selectedKind =
            hardMilestone <= softMilestone
              ? resolveReminderKind("hard", options.allowDelete)
              : resolveReminderKind("soft", options.allowDelete);

          if (hardMilestone <= softMilestone) {
            nextHard += options.hardRepeatEveryTokens;
          } else {
            nextSoft += options.softRepeatEveryTokens;
          }
        }

        if (selectedKind === undefined || selectedMilestone === undefined) {
          return;
        }

        // Consume every crossed milestone, but emit only the highest one at this anchor.
        const inspectListing = buildCompressionInspectListing({
          messages,
          policies: state.messagePolicies,
          to: policy.visibleId,
          mode: inspectMode,
          resultGroups: state.resultGroups,
        });
        const guidance = selectedKind.startsWith("hard")
          ? `当前可压缩原文共 ${compressibleTokens} 词元，建议本轮标记覆盖超过 ${Math.floor(compressibleTokens * 2 / 3)} 词元。按完整任务选区；符合条件的内容不足时说明原因，优先保留仍需使用的上下文。按成功 compact 标记返回的 tokenCount 合计，重叠覆盖只计一次；这是建议覆盖量，不是预计净节省量。`
          : undefined;
        const contentText = [
          options.promptTextByKind[selectedKind],
          guidance,
          retireSummaries ? options.retirePromptText : undefined,
        ].filter(Boolean).join("\n\n");
        reminders.push(
          Object.freeze({
            kind: selectedKind,
            anchorCanonicalId: policy.canonicalId,
            anchorVisibleId: policy.visibleId,
            visibleId: buildStableVisibleId(
              "reminder",
              policy.visibleSeq,
              `${selectedKind}:${policy.canonicalId}:${selectedMilestone}`,
            ),
            contentText,
            ...(inspectListing === undefined ? {} : { inspectListing }),
            inspectInput: { mode: inspectMode, to: policy.visibleId },
          } satisfies ReminderArtifact),
        );
      });

      return Object.freeze(reminders);
    },
  } satisfies ReminderService;
}

function resolveReminderKind(
  severity: "soft" | "hard",
  allowDelete: boolean,
): ReminderKind {
  if (severity === "soft") {
    return allowDelete ? "soft-delete" : "soft-compact";
  }

  return allowDelete ? "hard-delete" : "hard-compact";
}
