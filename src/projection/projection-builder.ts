import { defineInternalModuleContract } from "../internal/module-contract.js";
import type { CanonicalIdentityService } from "../identity/canonical-identity.js";
import type { HistoryReplayReader } from "../history/history-replay-reader.js";
import type { ResultGroupRepository } from "../state/result-group-repository.js";
import type { PolicyEngine } from "./policy-engine.js";
import type { ReminderService } from "./reminder-service.js";
import type {
  ProjectedMessageSet,
  ProjectionBuildInput,
  ProjectionState,
} from "./types.js";

export interface ProjectionBuilder {
  build(input: ProjectionBuildInput): Promise<ProjectedMessageSet>;
}

export interface ProjectionBuilderDependencies {
  readonly historyReplayReader: HistoryReplayReader;
  readonly policyEngine: PolicyEngine;
  readonly resultGroupRepository: ResultGroupRepository;
  readonly canonicalIdentityService: CanonicalIdentityService;
  readonly reminderService: ReminderService;
}

export const PROJECTION_BUILDER_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "ProjectionBuilder",
    inputs: ["ProjectionBuildInput"],
    outputs: ["ProjectedMessageSet"],
    mutability: "read-only",
    reads: [
      "canonical history replay",
      "result-group read model",
      "visible-id allocations",
      "policy/reminder outputs",
    ],
    writes: [],
    errorTypes: ["OVERLAP_CONFLICT", "RESULT_GROUP_INCOMPLETE"],
    idempotency:
      "Deterministic for the same replayed history, committed result groups, and visible-id allocations.",
    dependencyDirection: {
      inboundFrom: ["external-adapters"],
      outboundTo: [
        "HistoryReplayReader",
        "PolicyEngine",
        "ResultGroupRepository",
        "CanonicalIdentityService",
        "ReminderService",
      ],
    },
  });

export function createProjectionBuilder(
  dependencies: ProjectionBuilderDependencies,
): ProjectionBuilder {
  return {
    async build(input) {
      const history = await dependencies.historyReplayReader.read(input.sessionId);
      const markTree = dependencies.policyEngine.buildMarkTree(history);
      const conflicts = dependencies.policyEngine.detectConflicts(markTree);
      const rangeStart = history.messages[0]?.sequence ?? 1;
      const rangeEnd = history.messages.at(-1)?.sequence ?? 0;
      const resultGroups =
        rangeEnd >= rangeStart
          ? await dependencies.resultGroupRepository.listGroupsOverlappingRange(
              rangeStart,
              rangeEnd,
            )
          : [];

      void dependencies.canonicalIdentityService;

      const state = {
        sessionId: input.sessionId,
        history,
        markTree,
        conflicts,
        messagePolicies: Object.freeze([]),
        visibleIdAllocations: Object.freeze([]),
        resultGroups,
      } satisfies ProjectionState;
      const reminders = dependencies.reminderService.compute(state);

      return {
        sessionId: input.sessionId,
        messages: Object.freeze([]),
        reminders,
        conflicts,
        state,
      } satisfies ProjectedMessageSet;
    },
  } satisfies ProjectionBuilder;
}
