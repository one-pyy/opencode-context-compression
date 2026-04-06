import { defineInternalModuleContract } from "../internal/module-contract.js";
import type { ProjectionState, ReminderArtifact } from "./types.js";

export interface ReminderService {
  compute(state: ProjectionState): readonly ReminderArtifact[];
}

export const REMINDER_SERVICE_INTERNAL_CONTRACT = defineInternalModuleContract({
  module: "ReminderService",
  inputs: ["ProjectionState"],
  outputs: ["ReminderArtifact[]"],
  mutability: "read-only",
  reads: ["projection state", "policy-derived token totals and anchors"],
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
