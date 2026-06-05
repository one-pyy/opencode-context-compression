import { createHash } from "node:crypto";

import type { SqliteDatabase } from "../sqlite-runtime.js";
import {
  deriveStableVisibleSuffix,
  formatVisibleId,
} from "../../identity/visible-sequence.js";
import type { ReplayResultGroup } from "./types.js";

export function runInTransaction<Result>(
  database: SqliteDatabase,
  callback: () => Result,
): Result {
  if (database.isTransaction) {
    return callback();
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original failure; rollback can fail if SQLite already closed the transaction.
    }

    throw error;
  }
}

export function computeResultGroupPayloadSha256(
  resultGroup: ReplayResultGroup,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        markID: resultGroup.markID,
        mode: resultGroup.mode,
        sourceStartSeq: resultGroup.sourceStartSeq,
        sourceEndSeq: resultGroup.sourceEndSeq,
        modelName: resultGroup.modelName ?? null,
        executionMode: resultGroup.executionMode,
        createdAt: resultGroup.createdAt,
        committedAt: resultGroup.committedAt ?? null,
        fragments: resultGroup.fragments,
      }),
      "utf8",
    )
    .digest("hex");
}

export function deriveStableBase62Suffix(canonicalID: string): string {
  return deriveStableVisibleSuffix(canonicalID);
}

export function formatAssignedVisibleID(
  visibleKind: string,
  visibleSeq: number,
  visibleBase62: string,
): string {
  return formatVisibleId(visibleKind, visibleSeq, visibleBase62);
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
