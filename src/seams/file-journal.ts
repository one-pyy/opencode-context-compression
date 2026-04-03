import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SeamObservation, SeamObservationJournal } from "./noop-observation.js";

const DEFAULT_LOG_ENV = "OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG";

function resolveDefaultLogPath(): string {
  const filePath = fileURLToPath(import.meta.url);
  return join(dirname(dirname(filePath)), "..", "logs", "seam-observation.jsonl");
}

function ensureParentDirectory(filePath: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

export function createFileBackedSeamObservationJournal(
  base: SeamObservationJournal,
  filePath = process.env[DEFAULT_LOG_ENV]?.trim() || resolveDefaultLogPath(),
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
