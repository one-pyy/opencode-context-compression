import { createHash } from "node:crypto";

import type { SqliteDatabase } from "../sqlite-runtime.js";
import type { ReplayResultGroup } from "./types.js";

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE62_SUFFIX_LENGTH = 8;

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
    if (database.isTransaction) {
      database.exec("ROLLBACK");
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
  let value = BigInt(
    `0x${createHash("sha256").update(canonicalID, "utf8").digest("hex")}`,
  );
  let encoded = "";

  while (value > 0n) {
    const remainder = Number(value % 62n);
    encoded = `${BASE62_ALPHABET[remainder]}${encoded}`;
    value /= 62n;
  }

  return (encoded || "0")
    .slice(-BASE62_SUFFIX_LENGTH)
    .padStart(BASE62_SUFFIX_LENGTH, "0");
}

export function formatAssignedVisibleID(
  visibleKind: string,
  visibleSeq: number,
  visibleBase62: string,
): string {
  return `${visibleKind}_${String(visibleSeq).padStart(6, "0")}_${visibleBase62}`;
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
