import { defineInternalModuleContract } from "../internal/module-contract.js";
import { buildStableVisibleId } from "../identity/visible-sequence.js";
import type {
  ProjectedPromptMessage,
  ProjectionState,
  ReminderArtifact,
  ReminderKind,
} from "./types.js";

export interface ReminderComputationInput {
  readonly state: ProjectionState;
  readonly messages: readonly ProjectedPromptMessage[];
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
  readonly softRepeatEveryTokens: number;
  readonly hardRepeatEveryTokens: number;
  readonly allowDelete: boolean;
  readonly promptTextByKind: Readonly<Record<ReminderKind, string>>;
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
      let nextSoft = options.hsoft;
      let nextHard = options.hhard;

      messages.forEach((message) => {
        if (message.source !== "canonical" || message.canonicalId === undefined) {
          return;
        }

        const policy = policiesByCanonicalId.get(message.canonicalId);
        if (policy?.visibleKind !== "compressible") {
          return;
        }

        compressibleTokens += policy.tokenCount;

        while (true) {
          const softMilestone = nextSoft < options.hhard ? nextSoft : Number.POSITIVE_INFINITY;
          const hardMilestone = nextHard;
          const nextMilestone = Math.min(softMilestone, hardMilestone);
          if (compressibleTokens < nextMilestone) {
            break;
          }

          const kind =
            hardMilestone <= softMilestone
              ? resolveReminderKind("hard", options.allowDelete)
              : resolveReminderKind("soft", options.allowDelete);
          reminders.push(
            Object.freeze({
              kind,
              anchorCanonicalId: policy.canonicalId,
              anchorVisibleId: policy.visibleId,
              visibleId: buildStableVisibleId(
                "reminder",
                policy.visibleSeq,
                `${kind}:${policy.canonicalId}:${nextMilestone}`,
              ),
              contentText: options.promptTextByKind[kind],
            } satisfies ReminderArtifact),
          );

          if (hardMilestone <= softMilestone) {
            nextHard += options.hardRepeatEveryTokens;
          } else {
            nextSoft += options.softRepeatEveryTokens;
          }
        }
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
