import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { SeamObservation, SeamObservationJournal } from "./noop-observation.js";

function ensureParentDirectory(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

export function createFileBackedSeamObservationJournal(
  base: SeamObservationJournal,
  filePath: string,
): SeamObservationJournal {
  ensureParentDirectory(filePath);

  return {
    get entries() {
      return base.entries;
    },
    clear() {
      base.clear();
    },
    record(entry) {
      const observed = base.record(entry);
      appendObservation(filePath, observed);
      return observed;
    },
  };
}

function appendObservation(filePath: string, observation: SeamObservation): void {
  const line = JSON.stringify(observation);
  appendFileSync(filePath, `${line}\n`, "utf8");
}
