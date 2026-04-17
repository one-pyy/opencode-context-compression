import type { SqliteDatabase } from "../sqlite-runtime.js";
import {
  computeResultGroupPayloadSha256,
  runInTransaction,
} from "./helpers.js";
import type {
  ReplayResultGroup,
  SessionSidecarResultGroupRecord,
  SessionSidecarResultGroupUpsertResult,
  SessionSidecarResultGroupWrite,
} from "./types.js";
import { writeToastEvent } from "./toast-events.js";

interface ResultGroupRow extends Record<string, unknown> {
  readonly mark_id: string;
  readonly mode: "compact" | "delete";
  readonly source_start_seq: number;
  readonly source_end_seq: number;
  readonly fragment_count: number;
  readonly model_name: string | null;
  readonly execution_mode: string;
  readonly created_at: string;
  readonly committed_at: string | null;
  readonly payload_sha256: string;
}

interface ResultFragmentRow extends Record<string, unknown> {
  readonly mark_id: string;
  readonly fragment_index: number;
  readonly source_start_seq: number;
  readonly source_end_seq: number;
  readonly replacement_text: string;
}

export function insertCommittedResultGroup(
  database: SqliteDatabase,
  resultGroup: ReplayResultGroup,
): void {
  const payloadSha256 =
    resultGroup.payloadSha256 ?? computeResultGroupPayloadSha256(resultGroup);

  database
    .prepare(
      `
        INSERT INTO result_groups (
          mark_id,
          mode,
          source_start_seq,
          source_end_seq,
          fragment_count,
          model_name,
          execution_mode,
          created_at,
          committed_at,
          payload_sha256
        )
        VALUES (
          :mark_id,
          :mode,
          :source_start_seq,
          :source_end_seq,
          :fragment_count,
          :model_name,
          :execution_mode,
          :created_at,
          :committed_at,
          :payload_sha256
        )
      `,
    )
    .run({
      mark_id: resultGroup.markID,
      mode: resultGroup.mode,
      source_start_seq: resultGroup.sourceStartSeq,
      source_end_seq: resultGroup.sourceEndSeq,
      fragment_count: resultGroup.fragments.length,
      model_name: resultGroup.modelName ?? null,
      execution_mode: resultGroup.executionMode,
      created_at: resultGroup.createdAt,
      committed_at: resultGroup.committedAt ?? null,
      payload_sha256: payloadSha256,
    });

  const insertFragmentStatement = database.prepare(
    `
      INSERT INTO result_fragments (
        mark_id,
        fragment_index,
        source_start_seq,
        source_end_seq,
        replacement_text
      )
      VALUES (
        :mark_id,
        :fragment_index,
        :source_start_seq,
        :source_end_seq,
        :replacement_text
      )
    `,
  );

  resultGroup.fragments.forEach((fragment, fragmentIndex) => {
    insertFragmentStatement.run({
      mark_id: resultGroup.markID,
      fragment_index: fragmentIndex,
      source_start_seq: fragment.sourceStartSeq,
      source_end_seq: fragment.sourceEndSeq,
      replacement_text: fragment.replacementText,
    });
  });
}

export function createResultGroup(
  database: SqliteDatabase,
  resultGroup: SessionSidecarResultGroupWrite,
): SessionSidecarResultGroupRecord {
  const normalized = normalizeResultGroupWrite(resultGroup);

  return runInTransaction(database, () => {
    const existing = readResultGroup(database, normalized.markID);
    if (existing !== undefined) {
      throw new Error(
        `Committed result group for mark id '${normalized.markID}' already exists.`,
      );
    }

    insertCommittedResultGroup(database, normalized);
    return readResultGroup(database, normalized.markID)!;
  });
}

export function readResultGroup(
  database: SqliteDatabase,
  markID: string,
): SessionSidecarResultGroupRecord | undefined {
  const row = database
    .prepare<ResultGroupRow>(
      `
        SELECT mark_id, mode, source_start_seq, source_end_seq, fragment_count, model_name, execution_mode, created_at, committed_at, payload_sha256
        FROM result_groups
        WHERE mark_id = :mark_id
      `,
    )
    .get({ mark_id: markID });

  return row === undefined ? undefined : hydrateResultGroupRecord(database, row);
}

export function listResultGroups(
  database: SqliteDatabase,
): readonly SessionSidecarResultGroupRecord[] {
  return database
    .prepare<ResultGroupRow>(
      `
        SELECT mark_id, mode, source_start_seq, source_end_seq, fragment_count, model_name, execution_mode, created_at, committed_at, payload_sha256
        FROM result_groups
        ORDER BY source_start_seq ASC, source_end_seq ASC, mark_id ASC
      `,
    )
    .all()
    .map((row) => hydrateResultGroupRecord(database, row));
}

export function upsertResultGroup(
  database: SqliteDatabase,
  resultGroup: SessionSidecarResultGroupWrite,
): SessionSidecarResultGroupUpsertResult {
  const normalized = normalizeResultGroupWrite(resultGroup);

  return runInTransaction(database, () => {
    const existing = readResultGroup(database, normalized.markID);
    if (existing === undefined) {
      writeToastEvent(database, "compression_start");
      
      try {
        insertCommittedResultGroup(database, normalized);
        const inserted = readResultGroup(database, normalized.markID)!;
        
        writeToastEvent(database, "compression_complete", JSON.stringify({
          markId: normalized.markID,
          mode: normalized.mode,
        }));
        
        return {
          status: "inserted",
          resultGroup: inserted,
        };
      } catch (error) {
        writeToastEvent(database, "compression_failed", JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      }
    }

    const expected = mapReplayResultGroupToStoredRecord(normalized);
    if (!storedResultGroupsMatch(existing, expected)) {
      throw new Error(
        `Committed result group for mark id '${normalized.markID}' already exists with different content.`,
      );
    }

    return {
      status: "unchanged",
      resultGroup: existing,
    };
  });
}

function hydrateResultGroupRecord(
  database: SqliteDatabase,
  row: ResultGroupRow,
): SessionSidecarResultGroupRecord {
  const fragments = database
    .prepare<ResultFragmentRow>(
      `
        SELECT mark_id, fragment_index, source_start_seq, source_end_seq, replacement_text
        FROM result_fragments
        WHERE mark_id = :mark_id
        ORDER BY fragment_index ASC
      `,
    )
    .all({ mark_id: row.mark_id });

  if (fragments.length !== row.fragment_count) {
    throw new Error(
      `Committed result group '${row.mark_id}' is corrupt: expected ${row.fragment_count} fragments, found ${fragments.length}.`,
    );
  }

  fragments.forEach((fragment, fragmentIndex) => {
    if (fragment.fragment_index !== fragmentIndex) {
      throw new Error(
        `Committed result group '${row.mark_id}' is corrupt: expected fragment index ${fragmentIndex}, found ${fragment.fragment_index}.`,
      );
    }
  });

  return {
    markID: row.mark_id,
    mode: row.mode,
    sourceStartSeq: row.source_start_seq,
    sourceEndSeq: row.source_end_seq,
    fragmentCount: row.fragment_count,
    modelName: row.model_name ?? undefined,
    executionMode: row.execution_mode,
    createdAt: row.created_at,
    committedAt: row.committed_at ?? undefined,
    payloadSha256: row.payload_sha256,
    fragments: fragments.map((fragment) => ({
      fragmentIndex: fragment.fragment_index,
      sourceStartSeq: fragment.source_start_seq,
      sourceEndSeq: fragment.source_end_seq,
      replacementText: fragment.replacement_text,
    })),
  };
}

function normalizeResultGroupWrite(
  resultGroup: SessionSidecarResultGroupWrite,
): ReplayResultGroup {
  assertResultGroupWrite(resultGroup);

  return {
    markID: resultGroup.markID,
    mode: resultGroup.mode,
    sourceStartSeq: resultGroup.sourceStartSeq,
    sourceEndSeq: resultGroup.sourceEndSeq,
    modelName: resultGroup.modelName,
    executionMode: resultGroup.executionMode,
    createdAt: resultGroup.createdAt,
    committedAt: resultGroup.committedAt,
    payloadSha256: resultGroup.payloadSha256,
    fragments: resultGroup.fragments.map((fragment) => ({
      sourceStartSeq: fragment.sourceStartSeq,
      sourceEndSeq: fragment.sourceEndSeq,
      replacementText: fragment.replacementText,
    })),
  };
}

function assertResultGroupWrite(
  resultGroup: SessionSidecarResultGroupWrite,
): void {
  if (resultGroup.markID.length === 0) {
    throw new Error("Committed result group write requires a non-empty markID.");
  }

  if (resultGroup.fragments.length === 0) {
    throw new Error(
      `Committed result group '${resultGroup.markID}' must contain at least one fragment.`,
    );
  }

  resultGroup.fragments.forEach((fragment, fragmentIndex) => {
    if (fragment.sourceEndSeq < fragment.sourceStartSeq) {
      throw new Error(
        `Committed result group '${resultGroup.markID}' has fragment ${fragmentIndex} with source_end_seq before source_start_seq.`,
      );
    }
  });
}

function mapReplayResultGroupToStoredRecord(
  resultGroup: ReplayResultGroup,
): SessionSidecarResultGroupRecord {
  return {
    markID: resultGroup.markID,
    mode: resultGroup.mode,
    sourceStartSeq: resultGroup.sourceStartSeq,
    sourceEndSeq: resultGroup.sourceEndSeq,
    fragmentCount: resultGroup.fragments.length,
    modelName: resultGroup.modelName,
    executionMode: resultGroup.executionMode,
    createdAt: resultGroup.createdAt,
    committedAt: resultGroup.committedAt,
    payloadSha256:
      resultGroup.payloadSha256 ?? computeResultGroupPayloadSha256(resultGroup),
    fragments: resultGroup.fragments.map((fragment, fragmentIndex) => ({
      fragmentIndex,
      sourceStartSeq: fragment.sourceStartSeq,
      sourceEndSeq: fragment.sourceEndSeq,
      replacementText: fragment.replacementText,
    })),
  };
}

function storedResultGroupsMatch(
  left: SessionSidecarResultGroupRecord,
  right: SessionSidecarResultGroupRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
