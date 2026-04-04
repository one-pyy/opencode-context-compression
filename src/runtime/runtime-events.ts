import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { RuntimeLogLevel } from "../config/runtime-config.js";
import type { RecordRuntimeGateObservationInput, RuntimeGateObservationRecord } from "../state/store.js";

export interface RuntimeEventWriter {
  recordRuntimeGateObservation(
    input: RecordRuntimeGateObservationInput,
    observed: RuntimeGateObservationRecord,
  ): void;
}

export function createRuntimeEventWriter(options: {
  readonly filePath: string;
  readonly level: RuntimeLogLevel;
}): RuntimeEventWriter {
  ensureParentDirectory(options.filePath);

  return {
    recordRuntimeGateObservation(input, observed) {
      if (!shouldPersistRuntimeGateObservation(options.level, observed.observedState)) {
        return;
      }

      appendFileSync(
        options.filePath,
        `${JSON.stringify({
          event: "runtime_gate_observation",
          level: options.level,
          observationID: input.observationID,
          observedState: observed.observedState,
          gateName: observed.gateName,
          authority: observed.authority,
          lockPath: observed.lockPath,
          observedAtMs: observed.observedAtMs,
          startedAtMs: observed.startedAtMs,
          settledAtMs: observed.settledAtMs,
          activeJobCount: observed.activeJobCount,
          note: observed.note,
          metadata: observed.metadata,
        })}\n`,
        "utf8",
      );
    },
  };
}

function shouldPersistRuntimeGateObservation(level: RuntimeLogLevel, observedState: RuntimeGateObservationRecord["observedState"]): boolean {
  if (level === "off") {
    return false;
  }

  if (level === "error") {
    return observedState === "failed" || observedState === "stale";
  }

  return true;
}

function ensureParentDirectory(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}
