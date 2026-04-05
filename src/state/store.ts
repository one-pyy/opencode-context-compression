import { createHash } from "node:crypto";

import { getAppliedStateSchemaVersion } from "./schema.js";
import { openSessionDatabase, type OpenSessionDatabaseOptions } from "./session-db.js";
import type { SqliteDatabase } from "./sqlite-runtime.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CompactionExecutionMode = "compact" | "delete";
export type MarkStatus = "active" | "consumed" | "invalid";
export type ReplacementStatus = "committed" | "invalidated";
export type CompactionBatchStatus = "frozen" | "running" | "succeeded" | "failed" | "cancelled";
export type CompactionJobStatus = "queued" | "running" | "succeeded" | "failed" | "stale" | "cancelled";
export type CompactionAttemptStatus = "running" | "succeeded" | "failed" | "cancelled";
export type SourceSnapshotKind = "mark" | "replacement";
export type RuntimeGateName = "compressing";
export type RuntimeGateAuthority = "file-lock";
export type RuntimeGateObservedState =
  | "unlocked"
  | "running"
  | "succeeded"
  | "failed"
  | "stale"
  | "manually-cleared";

export interface CanonicalHostMessageInput {
  readonly hostMessageID: string;
  readonly canonicalMessageID: string;
  readonly role: string;
  readonly hostCreatedAtMs?: number;
  readonly metadata?: JsonValue;
}

export interface SyncCanonicalHostMessagesInput {
  readonly revision?: string;
  readonly syncedAtMs?: number;
  readonly messages: readonly CanonicalHostMessageInput[];
}

export interface HostMessageRecord {
  readonly hostMessageID: string;
  readonly canonicalMessageID: string;
  readonly role: string;
  readonly hostCreatedAtMs?: number;
  readonly canonicalPresent: boolean;
  readonly firstSeenAtMs: number;
  readonly lastSeenAtMs: number;
  readonly lastSeenRevision?: string;
  readonly visibleSeq?: number;
  readonly visibleChecksum?: string;
  readonly metadata?: JsonValue;
  readonly updatedAtMs: number;
}

export interface SessionStateRecord {
  readonly lastCanonicalRevision?: string;
  readonly lastSyncedAtMs?: number;
  readonly updatedAtMs: number;
}

export interface SourceSnapshotMessageInput {
  readonly hostMessageID: string;
  readonly role: string;
  readonly canonicalMessageID?: string;
  readonly contentHash?: string;
  readonly metadata?: JsonValue;
}

export interface SourceSnapshotInput {
  readonly snapshotID?: string;
  readonly sourceFingerprint?: string;
  readonly canonicalRevision?: string;
  readonly metadata?: JsonValue;
  readonly messages: readonly SourceSnapshotMessageInput[];
}

export interface SourceSnapshotRecord {
  readonly snapshotID: string;
  readonly snapshotKind: SourceSnapshotKind;
  readonly allowDelete: boolean;
  readonly sourceFingerprint: string;
  readonly canonicalRevision?: string;
  readonly sourceCount: number;
  readonly createdAtMs: number;
  readonly metadata?: JsonValue;
}

export interface SourceSnapshotMessageRecord {
  readonly snapshotID: string;
  readonly sourceIndex: number;
  readonly hostMessageID: string;
  readonly canonicalMessageID: string;
  readonly hostRole: string;
  readonly contentHash?: string;
  readonly metadata?: JsonValue;
}

export interface CreateMarkInput {
  readonly markID: string;
  readonly toolCallMessageID: string;
  readonly allowDelete: boolean;
  readonly markLabel?: string;
  readonly createdAtMs?: number;
  readonly metadata?: JsonValue;
  readonly sourceSnapshot: SourceSnapshotInput;
}

export interface MarkRecord {
  readonly markID: string;
  readonly toolCallMessageID: string;
  readonly allowDelete: boolean;
  readonly markLabel?: string;
  readonly sourceSnapshotID: string;
  readonly status: MarkStatus;
  readonly createdAtMs: number;
  readonly consumedAtMs?: number;
  readonly invalidatedAtMs?: number;
  readonly invalidationReason?: string;
  readonly metadata?: JsonValue;
}

export interface InvalidateMarkInput {
  readonly markID: string;
  readonly invalidatedAtMs?: number;
  readonly reason: string;
}

export interface CreateCompactionBatchInput {
  readonly batchID: string;
  readonly canonicalRevision?: string;
  readonly frozenAtMs?: number;
  readonly metadata?: JsonValue;
  readonly markIDs: readonly string[];
}

export interface CompactionBatchRecord {
  readonly batchID: string;
  readonly status: CompactionBatchStatus;
  readonly frozenAtMs: number;
  readonly canonicalRevision?: string;
  readonly metadata?: JsonValue;
}

export interface UpdateCompactionBatchStatusInput {
  readonly batchID: string;
  readonly status: CompactionBatchStatus;
  readonly metadata?: JsonValue;
}

export interface CompactionBatchMarkRecord {
  readonly batchID: string;
  readonly memberIndex: number;
  readonly markID: string;
  readonly sourceSnapshotID: string;
  readonly allowDelete: boolean;
}

export interface CreateCompactionJobInput {
  readonly jobID: string;
  readonly batchID: string;
  readonly markID: string;
  readonly queuedAtMs?: number;
  readonly status?: CompactionJobStatus;
  readonly startedAtMs?: number;
  readonly metadata?: JsonValue;
}

export interface UpdateCompactionJobStatusInput {
  readonly jobID: string;
  readonly status: CompactionJobStatus;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
  readonly finalErrorCode?: string;
  readonly finalErrorText?: string;
  readonly metadata?: JsonValue;
}

export interface CompactionJobRecord {
  readonly jobID: string;
  readonly batchID: string;
  readonly markID: string;
  readonly sourceSnapshotID: string;
  readonly status: CompactionJobStatus;
  readonly queuedAtMs: number;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
  readonly finalErrorCode?: string;
  readonly finalErrorText?: string;
  readonly metadata?: JsonValue;
}

export interface AppendCompactionJobAttemptInput {
  readonly jobID: string;
  readonly attemptIndex: number;
  readonly modelIndex: number;
  readonly modelName?: string;
  readonly status: CompactionAttemptStatus;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
  readonly errorCode?: string;
  readonly errorText?: string;
  readonly replacementID?: string;
  readonly metadata?: JsonValue;
}

export interface CompactionJobAttemptRecord {
  readonly jobID: string;
  readonly attemptIndex: number;
  readonly modelIndex: number;
  readonly modelName?: string;
  readonly status: CompactionAttemptStatus;
  readonly startedAtMs: number;
  readonly finishedAtMs?: number;
  readonly errorCode?: string;
  readonly errorText?: string;
  readonly replacementID?: string;
  readonly metadata?: JsonValue;
}

export interface CommitReplacementInput {
  readonly replacementID: string;
  readonly allowDelete: boolean;
  readonly executionMode: CompactionExecutionMode;
  readonly committedAtMs?: number;
  readonly batchID?: string;
  readonly jobID?: string;
  readonly contentText?: string;
  readonly contentJSON?: JsonValue;
  readonly metadata?: JsonValue;
  readonly markIDs?: readonly string[];
  readonly sourceSnapshot?: SourceSnapshotInput;
}

export interface ReplacementRecord {
  readonly replacementID: string;
  readonly allowDelete: boolean;
  readonly executionMode: CompactionExecutionMode;
  readonly sourceSnapshotID: string;
  readonly batchID?: string;
  readonly jobID?: string;
  readonly status: ReplacementStatus;
  readonly contentText?: string;
  readonly contentJSON?: JsonValue;
  readonly committedAtMs: number;
  readonly invalidatedAtMs?: number;
  readonly invalidationKind?: string;
  readonly invalidatedByMarkID?: string;
  readonly metadata?: JsonValue;
}

export interface ReplacementMarkLinkRecord {
  readonly replacementID: string;
  readonly markID: string;
  readonly linkKind: "consumed";
  readonly createdAtMs: number;
}

export interface InvalidateReplacementInput {
  readonly replacementID: string;
  readonly invalidatedAtMs?: number;
  readonly invalidationKind: string;
  readonly invalidatedByMarkID?: string;
}

export interface RecordRuntimeGateObservationInput {
  readonly observationID: string;
  readonly gateName?: RuntimeGateName;
  readonly authority?: RuntimeGateAuthority;
  readonly observedState: RuntimeGateObservedState;
  readonly lockPath?: string;
  readonly observedAtMs?: number;
  readonly startedAtMs?: number;
  readonly settledAtMs?: number;
  readonly activeJobCount?: number;
  readonly note?: string;
  readonly metadata?: JsonValue;
}

export interface RuntimeGateObservationRecord {
  readonly observationID: string;
  readonly gateName: RuntimeGateName;
  readonly authority: RuntimeGateAuthority;
  readonly observedState: RuntimeGateObservedState;
  readonly lockPath?: string;
  readonly observedAtMs: number;
  readonly startedAtMs?: number;
  readonly settledAtMs?: number;
  readonly activeJobCount?: number;
  readonly note?: string;
  readonly metadata?: JsonValue;
}

export interface VisibleSequenceAssignment {
  readonly hostMessageID: string;
  readonly visibleSeq: number;
  readonly visibleChecksum?: string;
}

export interface SqliteSessionStateStoreOptions extends OpenSessionDatabaseOptions {
  readonly now?: () => number;
}

export function createSqliteSessionStateStore(
  options: SqliteSessionStateStoreOptions,
): SqliteSessionStateStore {
  return new SqliteSessionStateStore(options);
}

export function computeSourceFingerprint(
  allowDelete: boolean,
  messages: readonly SourceSnapshotMessageInput[],
): string {
  const hash = createHash("sha256");
  hash.update(allowDelete ? "delete" : "keep");

  for (const message of messages) {
    hash.update("\u0000");
    hash.update(message.hostMessageID);
    hash.update("\u0000");
    hash.update(message.canonicalMessageID ?? "");
    hash.update("\u0000");
    hash.update(message.role);
    hash.update("\u0000");
    hash.update(message.contentHash ?? "");
  }

  return hash.digest("hex");
}

export class SqliteSessionStateStore {
  readonly databasePath: string;
  readonly sessionID: string;

  private readonly database: SqliteDatabase;
  private readonly now: () => number;

  constructor(options: SqliteSessionStateStoreOptions) {
    const handle = openSessionDatabase(options);

    this.database = handle.database;
    this.databasePath = handle.databasePath;
    this.sessionID = options.sessionID;
    this.now = options.now ?? Date.now;
  }

  close(): void {
    if (this.database.isOpen) {
      this.database.close();
    }
  }

  getSchemaVersion(): number {
    return getAppliedStateSchemaVersion(this.database);
  }

  getSessionState(): SessionStateRecord {
    const row = this.requireRow(
      this.database
        .prepare(
          `SELECT last_canonical_revision, last_synced_at_ms, updated_at_ms FROM session_state WHERE id = 1`,
        )
        .get() as SqlRow | undefined,
      "session_state",
    );

    return {
      lastCanonicalRevision: readOptionalString(row.last_canonical_revision),
      lastSyncedAtMs: readOptionalNumber(row.last_synced_at_ms),
      updatedAtMs: readRequiredNumber(row.updated_at_ms, "session_state.updated_at_ms"),
    };
  }

  syncCanonicalHostMessages(input: SyncCanonicalHostMessagesInput): void {
    const syncedAtMs = input.syncedAtMs ?? this.now();
    const upsertHostMessage = this.database.prepare(`
      INSERT INTO host_messages (
        host_message_id,
        canonical_message_id,
        role,
        host_created_at_ms,
        canonical_present,
        first_seen_at_ms,
        last_seen_at_ms,
        last_seen_revision,
        metadata_json,
        updated_at_ms
      ) VALUES (
        :hostMessageID,
        :canonicalMessageID,
        :role,
        :hostCreatedAtMs,
        1,
        :firstSeenAtMs,
        :lastSeenAtMs,
        :lastSeenRevision,
        :metadataJson,
        :updatedAtMs
      )
      ON CONFLICT(host_message_id) DO UPDATE SET
        canonical_message_id = excluded.canonical_message_id,
        role = excluded.role,
        host_created_at_ms = excluded.host_created_at_ms,
        canonical_present = 1,
        last_seen_at_ms = excluded.last_seen_at_ms,
        last_seen_revision = excluded.last_seen_revision,
        metadata_json = excluded.metadata_json,
        updated_at_ms = excluded.updated_at_ms
    `);

    this.transaction(() => {
      this.database.prepare(
        `UPDATE session_state
         SET last_canonical_revision = :lastCanonicalRevision,
             last_synced_at_ms = :lastSyncedAtMs,
             updated_at_ms = :updatedAtMs
         WHERE id = 1`,
      ).run({
        lastCanonicalRevision: input.revision ?? null,
        lastSyncedAtMs: syncedAtMs,
        updatedAtMs: syncedAtMs,
      });

      this.database
        .prepare(
          `UPDATE host_messages
           SET canonical_present = 0,
               updated_at_ms = :updatedAtMs
           WHERE canonical_present <> 0`,
        )
        .run({ updatedAtMs: syncedAtMs });

      for (const message of input.messages) {
        upsertHostMessage.run({
          hostMessageID: message.hostMessageID,
          canonicalMessageID: message.canonicalMessageID,
          role: message.role,
          hostCreatedAtMs: message.hostCreatedAtMs ?? null,
          firstSeenAtMs: syncedAtMs,
          lastSeenAtMs: syncedAtMs,
          lastSeenRevision: input.revision ?? null,
          metadataJson: serializeJson(message.metadata),
          updatedAtMs: syncedAtMs,
        });
      }
    });
  }

  listHostMessages(options?: { readonly presentOnly?: boolean }): HostMessageRecord[] {
    const statement = options?.presentOnly
      ? this.database.prepare(`
          SELECT *
          FROM host_messages
          WHERE canonical_present = 1
          ORDER BY first_seen_at_ms ASC, host_message_id ASC
        `)
      : this.database.prepare(`
          SELECT *
          FROM host_messages
          ORDER BY first_seen_at_ms ASC, host_message_id ASC
        `);

    return (statement.all() as SqlRow[]).map((row) => this.readHostMessageRecord(row));
  }

  getHostMessage(hostMessageID: string): HostMessageRecord | undefined {
    const row = this.database
      .prepare(`SELECT * FROM host_messages WHERE host_message_id = :hostMessageID`)
      .get({ hostMessageID }) as SqlRow | undefined;

    return row ? this.readHostMessageRecord(row) : undefined;
  }

  ensureVisibleSequenceAssignment(input: {
    readonly hostMessageID: string;
    readonly visibleChecksum?: string;
  }): VisibleSequenceAssignment {
    return this.transaction(() => {
      const current = this.requireHostMessage(input.hostMessageID);

      if (current.visibleSeq !== undefined) {
        if (
          current.visibleChecksum !== undefined &&
          input.visibleChecksum !== undefined &&
          current.visibleChecksum !== input.visibleChecksum
        ) {
          throw new Error(
            `Visible checksum mismatch for host message '${input.hostMessageID}': '${current.visibleChecksum}' !== '${input.visibleChecksum}'.`,
          );
        }

        if (current.visibleChecksum === undefined && input.visibleChecksum !== undefined) {
          this.database
            .prepare(
              `UPDATE host_messages
               SET visible_checksum = :visibleChecksum,
                   updated_at_ms = :updatedAtMs
               WHERE host_message_id = :hostMessageID`,
            )
            .run({
              hostMessageID: input.hostMessageID,
              visibleChecksum: input.visibleChecksum,
              updatedAtMs: this.now(),
            });
        }

        return {
          hostMessageID: current.hostMessageID,
          visibleSeq: current.visibleSeq,
          visibleChecksum: input.visibleChecksum ?? current.visibleChecksum,
        };
      }

      const row = this.requireRow(
        this.database
          .prepare(`SELECT next_seq FROM visible_sequence_state WHERE allocator_name = 'default'`)
          .get() as SqlRow | undefined,
        "visible_sequence_state.default",
      );
      const nextSeq = readRequiredNumber(row.next_seq, "visible_sequence_state.next_seq");
      const updatedAtMs = this.now();

      this.database
        .prepare(
          `UPDATE visible_sequence_state
           SET next_seq = :nextSeq,
               updated_at_ms = :updatedAtMs
           WHERE allocator_name = 'default'`,
        )
        .run({
          nextSeq: nextSeq + 1,
          updatedAtMs,
        });
      this.database
        .prepare(
          `UPDATE host_messages
           SET visible_seq = :visibleSeq,
               visible_checksum = :visibleChecksum,
               updated_at_ms = :updatedAtMs
           WHERE host_message_id = :hostMessageID`,
        )
        .run({
          hostMessageID: input.hostMessageID,
          visibleSeq: nextSeq,
          visibleChecksum: input.visibleChecksum ?? null,
          updatedAtMs,
        });

      return {
        hostMessageID: input.hostMessageID,
        visibleSeq: nextSeq,
        visibleChecksum: input.visibleChecksum,
      };
    });
  }

  createMark(input: CreateMarkInput): MarkRecord {
    const createdAtMs = input.createdAtMs ?? this.now();

    return this.transaction(() => {
      this.requireHostMessage(input.toolCallMessageID);

      const sourceSnapshotID = this.insertSourceSnapshot({
        snapshotID: input.sourceSnapshot.snapshotID ?? `${input.markID}:snapshot`,
        snapshotKind: "mark",
        allowDelete: input.allowDelete,
        createdAtMs,
        input: input.sourceSnapshot,
      });

      this.database
        .prepare(
          `INSERT INTO marks (
             mark_id,
             tool_call_message_id,
             allow_delete,
             mark_label,
             source_snapshot_id,
             status,
             created_at_ms,
             metadata_json
           ) VALUES (
             :markID,
             :toolCallMessageID,
             :allowDelete,
             :markLabel,
             :sourceSnapshotID,
             'active',
             :createdAtMs,
             :metadataJson
           )`,
        )
        .run({
          markID: input.markID,
          toolCallMessageID: input.toolCallMessageID,
          allowDelete: input.allowDelete ? 1 : 0,
          markLabel: input.markLabel ?? null,
          sourceSnapshotID,
          createdAtMs,
          metadataJson: serializeJson(input.metadata),
        });

      return this.requireMark(input.markID);
    });
  }

  getMark(markID: string): MarkRecord | undefined {
    const row = this.database.prepare(`SELECT * FROM marks WHERE mark_id = :markID`).get({
      markID,
    }) as SqlRow | undefined;

    return row ? this.readMarkRecord(row) : undefined;
  }

  getMarkByToolCallMessageID(toolCallMessageID: string): MarkRecord | undefined {
    const row = this.database
      .prepare(`SELECT * FROM marks WHERE tool_call_message_id = :toolCallMessageID`)
      .get({ toolCallMessageID }) as SqlRow | undefined;

    return row ? this.readMarkRecord(row) : undefined;
  }

  listMarks(options?: { readonly status?: MarkStatus }): MarkRecord[] {
    const statement = options?.status
      ? this.database.prepare(
          `SELECT *
           FROM marks
           WHERE status = :status
           ORDER BY created_at_ms ASC, mark_id ASC`,
        )
      : this.database.prepare(`
          SELECT *
          FROM marks
          ORDER BY created_at_ms ASC, mark_id ASC
        `);

    return (
      (options?.status
        ? statement.all({ status: options.status })
        : statement.all()) as SqlRow[]
    ).map((row) => this.readMarkRecord(row));
  }

  invalidateMark(input: InvalidateMarkInput): MarkRecord {
    const invalidatedAtMs = input.invalidatedAtMs ?? this.now();

    return this.transaction(() => {
      this.requireMark(input.markID);
      this.database
        .prepare(
          `UPDATE marks
           SET status = 'invalid',
               invalidated_at_ms = :invalidatedAtMs,
               invalidation_reason = :invalidationReason
           WHERE mark_id = :markID`,
        )
        .run({
          markID: input.markID,
          invalidatedAtMs,
          invalidationReason: input.reason,
        });

      return this.requireMark(input.markID);
    });
  }

  listMarkSourceMessages(markID: string): SourceSnapshotMessageRecord[] {
    const mark = this.requireMark(markID);
    return this.listSourceSnapshotMessages(mark.sourceSnapshotID);
  }

  getSourceSnapshot(snapshotID: string): SourceSnapshotRecord | undefined {
    const row = this.database
      .prepare(`SELECT * FROM source_snapshots WHERE snapshot_id = :snapshotID`)
      .get({ snapshotID }) as SqlRow | undefined;

    return row ? this.readSourceSnapshotRecord(row) : undefined;
  }

  createCompactionBatch(input: CreateCompactionBatchInput): CompactionBatchRecord {
    if (input.markIDs.length === 0) {
      throw new Error("Compaction batches require at least one mark.");
    }

    const frozenAtMs = input.frozenAtMs ?? this.now();

    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO compaction_batches (
             batch_id,
             status,
             frozen_at_ms,
             canonical_revision,
             metadata_json
           ) VALUES (
             :batchID,
             'frozen',
             :frozenAtMs,
             :canonicalRevision,
             :metadataJson
           )`,
        )
        .run({
          batchID: input.batchID,
          frozenAtMs,
          canonicalRevision: input.canonicalRevision ?? null,
          metadataJson: serializeJson(input.metadata),
        });

      const insertBatchMember = this.database.prepare(
          `INSERT INTO compaction_batch_marks (
           batch_id,
           member_index,
           mark_id,
           source_snapshot_id,
           allow_delete
         ) VALUES (
           :batchID,
           :memberIndex,
           :markID,
           :sourceSnapshotID,
           :allowDelete
         )`,
      );

      input.markIDs.forEach((markID, memberIndex) => {
        const mark = this.requireMark(markID);
        if (mark.status !== "active") {
          throw new Error(`Cannot freeze mark '${markID}' because its status is '${mark.status}'.`);
        }

        insertBatchMember.run({
          batchID: input.batchID,
          memberIndex,
          markID,
          sourceSnapshotID: mark.sourceSnapshotID,
          allowDelete: mark.allowDelete ? 1 : 0,
        });
      });

      return this.requireCompactionBatch(input.batchID);
    });
  }

  getCompactionBatch(batchID: string): CompactionBatchRecord | undefined {
    const row = this.database
      .prepare(`SELECT * FROM compaction_batches WHERE batch_id = :batchID`)
      .get({ batchID }) as SqlRow | undefined;

    return row ? this.readCompactionBatchRecord(row) : undefined;
  }

  findCompactionBatchByFrozenAtMs(frozenAtMs: number): CompactionBatchRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT *
         FROM compaction_batches
         WHERE frozen_at_ms = :frozenAtMs
         ORDER BY batch_id DESC
         LIMIT 1`,
      )
      .get({ frozenAtMs }) as SqlRow | undefined;

    return row ? this.readCompactionBatchRecord(row) : undefined;
  }

  updateCompactionBatchStatus(input: UpdateCompactionBatchStatusInput): CompactionBatchRecord {
    return this.transaction(() => {
      const current = this.requireCompactionBatch(input.batchID);
      this.database
        .prepare(
          `UPDATE compaction_batches
           SET status = :status,
               metadata_json = :metadataJson
           WHERE batch_id = :batchID`,
        )
        .run({
          batchID: input.batchID,
          status: input.status,
          metadataJson: serializeJson(input.metadata ?? current.metadata),
        });

      return this.requireCompactionBatch(input.batchID);
    });
  }

  listCompactionBatchMarks(batchID: string): CompactionBatchMarkRecord[] {
    return (
      this.database
        .prepare(
          `SELECT *
           FROM compaction_batch_marks
           WHERE batch_id = :batchID
           ORDER BY member_index ASC`,
        )
        .all({ batchID }) as SqlRow[]
    ).map((row) => this.readCompactionBatchMarkRecord(row));
  }

  createCompactionJob(input: CreateCompactionJobInput): CompactionJobRecord {
    const queuedAtMs = input.queuedAtMs ?? this.now();
    const status = input.status ?? "queued";

    return this.transaction(() => {
      const batchMember = this.requireRow(
        this.database
          .prepare(
            `SELECT source_snapshot_id
             FROM compaction_batch_marks
             WHERE batch_id = :batchID AND mark_id = :markID`,
          )
          .get({
            batchID: input.batchID,
            markID: input.markID,
          }) as SqlRow | undefined,
        `compaction_batch_marks(${input.batchID}, ${input.markID})`,
      );

      this.database
        .prepare(
          `INSERT INTO compaction_jobs (
             job_id,
             batch_id,
             mark_id,
             source_snapshot_id,
             status,
             queued_at_ms,
             started_at_ms,
             metadata_json
           ) VALUES (
             :jobID,
             :batchID,
             :markID,
             :sourceSnapshotID,
             :status,
             :queuedAtMs,
             :startedAtMs,
             :metadataJson
           )`,
        )
        .run({
          jobID: input.jobID,
          batchID: input.batchID,
          markID: input.markID,
          sourceSnapshotID: readRequiredString(
            batchMember.source_snapshot_id,
            "compaction_batch_marks.source_snapshot_id",
          ),
          status,
          queuedAtMs,
          startedAtMs: input.startedAtMs ?? null,
          metadataJson: serializeJson(input.metadata),
        });

      return this.requireCompactionJob(input.jobID);
    });
  }

  getCompactionJob(jobID: string): CompactionJobRecord | undefined {
    const row = this.database
      .prepare(`SELECT * FROM compaction_jobs WHERE job_id = :jobID`)
      .get({ jobID }) as SqlRow | undefined;

    return row ? this.readCompactionJobRecord(row) : undefined;
  }

  updateCompactionJobStatus(input: UpdateCompactionJobStatusInput): CompactionJobRecord {
    return this.transaction(() => {
      const current = this.requireCompactionJob(input.jobID);

      this.database
        .prepare(
          `UPDATE compaction_jobs
           SET status = :status,
               started_at_ms = :startedAtMs,
               finished_at_ms = :finishedAtMs,
               final_error_code = :finalErrorCode,
               final_error_text = :finalErrorText,
               metadata_json = :metadataJson
           WHERE job_id = :jobID`,
        )
        .run({
          jobID: input.jobID,
          status: input.status,
          startedAtMs: input.startedAtMs ?? current.startedAtMs ?? null,
          finishedAtMs: input.finishedAtMs ?? current.finishedAtMs ?? null,
          finalErrorCode: input.finalErrorCode ?? current.finalErrorCode ?? null,
          finalErrorText: input.finalErrorText ?? current.finalErrorText ?? null,
          metadataJson: serializeJson(input.metadata ?? current.metadata),
        });

      return this.requireCompactionJob(input.jobID);
    });
  }

  appendCompactionJobAttempt(input: AppendCompactionJobAttemptInput): CompactionJobAttemptRecord {
    const startedAtMs = input.startedAtMs ?? this.now();

    return this.transaction(() => {
      this.requireCompactionJob(input.jobID);
      if (input.replacementID !== undefined) {
        this.requireReplacement(input.replacementID);
      }

      this.database
        .prepare(
          `INSERT INTO compaction_job_attempts (
             job_id,
             attempt_index,
             model_index,
             model_name,
             status,
             started_at_ms,
             finished_at_ms,
             error_code,
             error_text,
             replacement_id,
             metadata_json
           ) VALUES (
             :jobID,
             :attemptIndex,
             :modelIndex,
             :modelName,
             :status,
             :startedAtMs,
             :finishedAtMs,
             :errorCode,
             :errorText,
             :replacementID,
             :metadataJson
           )`,
        )
        .run({
          jobID: input.jobID,
          attemptIndex: input.attemptIndex,
          modelIndex: input.modelIndex,
          modelName: input.modelName ?? null,
          status: input.status,
          startedAtMs,
          finishedAtMs: input.finishedAtMs ?? null,
          errorCode: input.errorCode ?? null,
          errorText: input.errorText ?? null,
          replacementID: input.replacementID ?? null,
          metadataJson: serializeJson(input.metadata),
        });

      return this.requireCompactionJobAttempt(input.jobID, input.attemptIndex);
    });
  }

  listCompactionJobAttempts(jobID: string): CompactionJobAttemptRecord[] {
    return (
      this.database
        .prepare(
          `SELECT *
           FROM compaction_job_attempts
           WHERE job_id = :jobID
           ORDER BY attempt_index ASC`,
        )
        .all({ jobID }) as SqlRow[]
    ).map((row) => this.readCompactionJobAttemptRecord(row));
  }

  commitReplacement(input: CommitReplacementInput): ReplacementRecord {
    const committedAtMs = input.committedAtMs ?? this.now();

    return this.transaction(() => {
      let batchID = input.batchID;
      let sourceSnapshotID: string;
      let defaultLinkedMarkID: string | undefined;

      if (input.sourceSnapshot !== undefined) {
        sourceSnapshotID = this.insertSourceSnapshot({
          snapshotID: input.sourceSnapshot.snapshotID ?? `${input.replacementID}:snapshot`,
          snapshotKind: "replacement",
          allowDelete: input.allowDelete,
          createdAtMs: committedAtMs,
          input: input.sourceSnapshot,
        });
      } else if (input.jobID !== undefined) {
        const job = this.requireCompactionJob(input.jobID);
        batchID ??= job.batchID;
        defaultLinkedMarkID = job.markID;
        sourceSnapshotID = this.cloneSourceSnapshot({
          existingSnapshotID: job.sourceSnapshotID,
          snapshotID: `${input.replacementID}:snapshot`,
          snapshotKind: "replacement",
          allowDelete: input.allowDelete,
          createdAtMs: committedAtMs,
        });
      } else {
        throw new Error("Committing a replacement requires either a source snapshot or a compaction job.");
      }

      const linkedMarkIDs = [...new Set(input.markIDs ?? (defaultLinkedMarkID ? [defaultLinkedMarkID] : []))];
      for (const markID of linkedMarkIDs) {
        const mark = this.requireMark(markID);
        if (!this.areSourceSnapshotsEquivalent(mark.sourceSnapshotID, sourceSnapshotID)) {
          throw new Error(
            `Replacement '${input.replacementID}' cannot consume mark '${markID}' because their source snapshots differ.`,
          );
        }
      }

      this.database
        .prepare(
          `INSERT INTO replacements (
             replacement_id,
             allow_delete,
             execution_mode,
             source_snapshot_id,
             batch_id,
             job_id,
             status,
             content_text,
             content_json,
             committed_at_ms,
             metadata_json
           ) VALUES (
             :replacementID,
             :allowDelete,
             :executionMode,
             :sourceSnapshotID,
             :batchID,
             :jobID,
             'committed',
             :contentText,
             :contentJson,
             :committedAtMs,
             :metadataJson
           )`,
        )
        .run({
          replacementID: input.replacementID,
          allowDelete: input.allowDelete ? 1 : 0,
          executionMode: input.executionMode,
          sourceSnapshotID,
          batchID: batchID ?? null,
          jobID: input.jobID ?? null,
          contentText: input.contentText ?? null,
          contentJson: serializeJson(input.contentJSON),
          committedAtMs,
          metadataJson: serializeJson(input.metadata),
        });

      const insertLink = this.database.prepare(
        `INSERT INTO replacement_mark_links (
           replacement_id,
           mark_id,
           link_kind,
           created_at_ms
         ) VALUES (
           :replacementID,
           :markID,
           'consumed',
           :createdAtMs
         )`,
      );

      for (const markID of linkedMarkIDs) {
        insertLink.run({
          replacementID: input.replacementID,
          markID,
          createdAtMs: committedAtMs,
        });

        this.database
          .prepare(
            `UPDATE marks
             SET status = 'consumed',
                 consumed_at_ms = :consumedAtMs
             WHERE mark_id = :markID`,
          )
          .run({
            markID,
            consumedAtMs: committedAtMs,
          });
      }

      return this.requireReplacement(input.replacementID);
    });
  }

  getReplacement(replacementID: string): ReplacementRecord | undefined {
    const row = this.database
      .prepare(`SELECT * FROM replacements WHERE replacement_id = :replacementID`)
      .get({ replacementID }) as SqlRow | undefined;

    return row ? this.readReplacementRecord(row) : undefined;
  }

  listReplacementSourceMessages(replacementID: string): SourceSnapshotMessageRecord[] {
    const replacement = this.requireReplacement(replacementID);
    return this.listSourceSnapshotMessages(replacement.sourceSnapshotID);
  }

  listReplacementMarkLinks(replacementID: string): ReplacementMarkLinkRecord[] {
    return (
      this.database
        .prepare(
          `SELECT *
           FROM replacement_mark_links
           WHERE replacement_id = :replacementID
           ORDER BY created_at_ms ASC, mark_id ASC`,
        )
        .all({ replacementID }) as SqlRow[]
    ).map((row) => this.readReplacementMarkLinkRecord(row));
  }

  findFirstCommittedReplacementForMark(markID: string): ReplacementRecord | undefined {
    const mark = this.requireMark(markID);
    const targetSnapshot = this.requireSourceSnapshot(mark.sourceSnapshotID);
    const candidateRows = this.database
      .prepare(
        `SELECT replacements.*
         FROM replacements
         JOIN source_snapshots
           ON source_snapshots.snapshot_id = replacements.source_snapshot_id
         WHERE replacements.allow_delete = :allowDelete
           AND replacements.status = 'committed'
           AND replacements.invalidated_at_ms IS NULL
           AND source_snapshots.source_fingerprint = :sourceFingerprint
           AND source_snapshots.source_count = :sourceCount
         ORDER BY replacements.committed_at_ms DESC, replacements.replacement_id DESC`,
      )
      .all({
        allowDelete: mark.allowDelete ? 1 : 0,
        sourceFingerprint: targetSnapshot.sourceFingerprint,
        sourceCount: targetSnapshot.sourceCount,
      }) as SqlRow[];

    for (const row of candidateRows) {
      const replacement = this.readReplacementRecord(row);
      if (this.areSourceSnapshotsEquivalent(mark.sourceSnapshotID, replacement.sourceSnapshotID)) {
        return replacement;
      }
    }

    return undefined;
  }

  invalidateReplacement(input: InvalidateReplacementInput): ReplacementRecord {
    const invalidatedAtMs = input.invalidatedAtMs ?? this.now();

    return this.transaction(() => {
      const current = this.requireReplacement(input.replacementID);
      if (input.invalidatedByMarkID !== undefined) {
        this.requireMark(input.invalidatedByMarkID);
      }

      this.database
        .prepare(
          `UPDATE replacements
           SET status = 'invalidated',
               invalidated_at_ms = :invalidatedAtMs,
               invalidation_kind = :invalidationKind,
               invalidated_by_mark_id = :invalidatedByMarkID
           WHERE replacement_id = :replacementID`,
        )
        .run({
          replacementID: input.replacementID,
          invalidatedAtMs,
          invalidationKind: input.invalidationKind,
          invalidatedByMarkID: input.invalidatedByMarkID ?? current.invalidatedByMarkID ?? null,
        });

      return this.requireReplacement(input.replacementID);
    });
  }

  recordRuntimeGateObservation(input: RecordRuntimeGateObservationInput): RuntimeGateObservationRecord {
    const observedAtMs = input.observedAtMs ?? this.now();

    this.database
      .prepare(
        `INSERT INTO runtime_gate_audit (
           observation_id,
           gate_name,
           authority,
           observed_state,
           lock_path,
           observed_at_ms,
           started_at_ms,
           settled_at_ms,
           active_job_count,
           note,
           metadata_json
         ) VALUES (
           :observationID,
           :gateName,
           :authority,
           :observedState,
           :lockPath,
           :observedAtMs,
           :startedAtMs,
           :settledAtMs,
           :activeJobCount,
           :note,
           :metadataJson
         )`,
      )
      .run({
        observationID: input.observationID,
        gateName: input.gateName ?? "compressing",
        authority: input.authority ?? "file-lock",
        observedState: input.observedState,
        lockPath: input.lockPath ?? null,
        observedAtMs,
        startedAtMs: input.startedAtMs ?? null,
        settledAtMs: input.settledAtMs ?? null,
        activeJobCount: input.activeJobCount ?? null,
        note: input.note ?? null,
        metadataJson: serializeJson(input.metadata),
      });

    return this.requireRuntimeGateObservation(input.observationID);
  }

  getLatestRuntimeGateObservation(gateName: RuntimeGateName = "compressing"): RuntimeGateObservationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT *
         FROM runtime_gate_audit
         WHERE gate_name = :gateName
         ORDER BY observed_at_ms DESC, observation_id DESC
         LIMIT 1`,
      )
      .get({ gateName }) as SqlRow | undefined;

    return row ? this.readRuntimeGateObservationRecord(row) : undefined;
  }

  private transaction<T>(run: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");

    try {
      const result = run();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private insertSourceSnapshot(options: {
    readonly snapshotID: string;
    readonly snapshotKind: SourceSnapshotKind;
    readonly allowDelete: boolean;
    readonly createdAtMs: number;
    readonly input: SourceSnapshotInput;
  }): string {
    const { input } = options;

    if (input.messages.length === 0) {
      throw new Error(`Source snapshot '${options.snapshotID}' requires at least one source message.`);
    }

    const normalizedMessages = input.messages.map((message) => {
      const hostMessage = this.requireHostMessage(message.hostMessageID);
      if (hostMessage.role !== message.role) {
        throw new Error(
          `Source snapshot '${options.snapshotID}' role mismatch for host message '${message.hostMessageID}'.`,
        );
      }
      if (
        message.canonicalMessageID !== undefined &&
        message.canonicalMessageID !== hostMessage.canonicalMessageID
      ) {
        throw new Error(
          `Source snapshot '${options.snapshotID}' canonical id mismatch for host message '${message.hostMessageID}'.`,
        );
      }

      return {
        hostMessageID: message.hostMessageID,
        canonicalMessageID: message.canonicalMessageID ?? hostMessage.canonicalMessageID,
        role: message.role,
        contentHash: message.contentHash,
        metadata: message.metadata,
      } satisfies Required<Pick<SourceSnapshotMessageInput, "hostMessageID" | "canonicalMessageID" | "role">> &
        Pick<SourceSnapshotMessageInput, "contentHash" | "metadata">;
    });

    const sourceFingerprint =
      input.sourceFingerprint ??
      computeSourceFingerprint(options.allowDelete, normalizedMessages);

    this.database
      .prepare(
        `INSERT INTO source_snapshots (
           snapshot_id,
           snapshot_kind,
           allow_delete,
           source_fingerprint,
           canonical_revision,
           source_count,
           created_at_ms,
           metadata_json
         ) VALUES (
           :snapshotID,
           :snapshotKind,
           :allowDelete,
           :sourceFingerprint,
           :canonicalRevision,
           :sourceCount,
           :createdAtMs,
           :metadataJson
         )`,
      )
      .run({
        snapshotID: options.snapshotID,
        snapshotKind: options.snapshotKind,
        allowDelete: options.allowDelete ? 1 : 0,
        sourceFingerprint,
        canonicalRevision: input.canonicalRevision ?? null,
        sourceCount: input.messages.length,
        createdAtMs: options.createdAtMs,
        metadataJson: serializeJson(input.metadata),
      });

    const insertSourceMessage = this.database.prepare(
      `INSERT INTO source_snapshot_messages (
         snapshot_id,
         source_index,
         host_message_id,
         canonical_message_id,
         host_role,
         content_hash,
         metadata_json
       ) VALUES (
         :snapshotID,
         :sourceIndex,
         :hostMessageID,
         :canonicalMessageID,
         :hostRole,
         :contentHash,
         :metadataJson
       )`,
    );

    normalizedMessages.forEach((message, sourceIndex) => {
      insertSourceMessage.run({
        snapshotID: options.snapshotID,
        sourceIndex,
        hostMessageID: message.hostMessageID,
        canonicalMessageID: message.canonicalMessageID,
        hostRole: message.role,
        contentHash: message.contentHash ?? null,
        metadataJson: serializeJson(message.metadata),
      });
    });

    return options.snapshotID;
  }

  private cloneSourceSnapshot(options: {
    readonly existingSnapshotID: string;
    readonly snapshotID: string;
    readonly snapshotKind: SourceSnapshotKind;
    readonly allowDelete: boolean;
    readonly createdAtMs: number;
  }): string {
    const existingSnapshot = this.requireSourceSnapshot(options.existingSnapshotID);
    if (existingSnapshot.allowDelete !== options.allowDelete) {
      throw new Error(
        `Cannot clone source snapshot '${options.existingSnapshotID}' with allowDelete='${String(options.allowDelete)}' because its allowDelete is '${String(existingSnapshot.allowDelete)}'.`,
      );
    }

    const existingMessages = this.listSourceSnapshotMessages(options.existingSnapshotID).map((message) => ({
      hostMessageID: message.hostMessageID,
      canonicalMessageID: message.canonicalMessageID,
      role: message.hostRole,
      contentHash: message.contentHash,
      metadata: message.metadata,
    }));

    return this.insertSourceSnapshot({
      snapshotID: options.snapshotID,
      snapshotKind: options.snapshotKind,
      allowDelete: options.allowDelete,
      createdAtMs: options.createdAtMs,
      input: {
        sourceFingerprint: existingSnapshot.sourceFingerprint,
        canonicalRevision: existingSnapshot.canonicalRevision,
        metadata: existingSnapshot.metadata,
        messages: existingMessages,
      },
    });
  }

  private areSourceSnapshotsEquivalent(leftSnapshotID: string, rightSnapshotID: string): boolean {
    const leftSnapshot = this.requireSourceSnapshot(leftSnapshotID);
    const rightSnapshot = this.requireSourceSnapshot(rightSnapshotID);

    if (
      leftSnapshot.allowDelete !== rightSnapshot.allowDelete ||
      leftSnapshot.sourceFingerprint !== rightSnapshot.sourceFingerprint ||
      leftSnapshot.sourceCount !== rightSnapshot.sourceCount
    ) {
      return false;
    }

    const leftMessages = this.listSourceSnapshotMessages(leftSnapshotID);
    const rightMessages = this.listSourceSnapshotMessages(rightSnapshotID);
    if (leftMessages.length !== rightMessages.length) {
      return false;
    }

    return leftMessages.every((leftMessage, index) => {
      const rightMessage = rightMessages[index];
      return (
        rightMessage !== undefined &&
        leftMessage.hostMessageID === rightMessage.hostMessageID &&
        leftMessage.canonicalMessageID === rightMessage.canonicalMessageID &&
        leftMessage.hostRole === rightMessage.hostRole &&
        leftMessage.contentHash === rightMessage.contentHash
      );
    });
  }

  listSourceSnapshotMessages(snapshotID: string): SourceSnapshotMessageRecord[] {
    return (
      this.database
        .prepare(
          `SELECT *
           FROM source_snapshot_messages
           WHERE snapshot_id = :snapshotID
           ORDER BY source_index ASC`,
        )
        .all({ snapshotID }) as SqlRow[]
    ).map((row) => this.readSourceSnapshotMessageRecord(row));
  }

  private requireSourceSnapshot(snapshotID: string): SourceSnapshotRecord {
    const snapshot = this.getSourceSnapshot(snapshotID);
    if (snapshot === undefined) {
      throw new Error(`Unknown source snapshot '${snapshotID}'.`);
    }

    return snapshot;
  }

  private requireHostMessage(hostMessageID: string): HostMessageRecord {
    const hostMessage = this.getHostMessage(hostMessageID);
    if (hostMessage === undefined) {
      throw new Error(`Unknown host message '${hostMessageID}'. Sync canonical host history first.`);
    }

    return hostMessage;
  }

  private requireMark(markID: string): MarkRecord {
    const mark = this.getMark(markID);
    if (mark === undefined) {
      throw new Error(`Unknown mark '${markID}'.`);
    }

    return mark;
  }

  private requireCompactionBatch(batchID: string): CompactionBatchRecord {
    const batch = this.getCompactionBatch(batchID);
    if (batch === undefined) {
      throw new Error(`Unknown compaction batch '${batchID}'.`);
    }

    return batch;
  }

  private requireCompactionJob(jobID: string): CompactionJobRecord {
    const job = this.getCompactionJob(jobID);
    if (job === undefined) {
      throw new Error(`Unknown compaction job '${jobID}'.`);
    }

    return job;
  }

  private requireCompactionJobAttempt(jobID: string, attemptIndex: number): CompactionJobAttemptRecord {
    const row = this.database
      .prepare(
        `SELECT *
         FROM compaction_job_attempts
         WHERE job_id = :jobID AND attempt_index = :attemptIndex`,
      )
      .get({ jobID, attemptIndex }) as SqlRow | undefined;

    return this.readCompactionJobAttemptRecord(
      this.requireRow(row, `compaction_job_attempts(${jobID}, ${attemptIndex})`),
    );
  }

  private requireReplacement(replacementID: string): ReplacementRecord {
    const replacement = this.getReplacement(replacementID);
    if (replacement === undefined) {
      throw new Error(`Unknown replacement '${replacementID}'.`);
    }

    return replacement;
  }

  private requireRuntimeGateObservation(observationID: string): RuntimeGateObservationRecord {
    const row = this.database
      .prepare(`SELECT * FROM runtime_gate_audit WHERE observation_id = :observationID`)
      .get({ observationID }) as SqlRow | undefined;

    return this.readRuntimeGateObservationRecord(
      this.requireRow(row, `runtime_gate_audit(${observationID})`),
    );
  }

  private readHostMessageRecord(row: SqlRow): HostMessageRecord {
    return {
      hostMessageID: readRequiredString(row.host_message_id, "host_messages.host_message_id"),
      canonicalMessageID: readRequiredString(
        row.canonical_message_id,
        "host_messages.canonical_message_id",
      ),
      role: readRequiredString(row.role, "host_messages.role"),
      hostCreatedAtMs: readOptionalNumber(row.host_created_at_ms),
      canonicalPresent: readBooleanInt(row.canonical_present, "host_messages.canonical_present"),
      firstSeenAtMs: readRequiredNumber(row.first_seen_at_ms, "host_messages.first_seen_at_ms"),
      lastSeenAtMs: readRequiredNumber(row.last_seen_at_ms, "host_messages.last_seen_at_ms"),
      lastSeenRevision: readOptionalString(row.last_seen_revision),
      visibleSeq: readOptionalNumber(row.visible_seq),
      visibleChecksum: readOptionalString(row.visible_checksum),
      metadata: parseJson(row.metadata_json),
      updatedAtMs: readRequiredNumber(row.updated_at_ms, "host_messages.updated_at_ms"),
    };
  }

  private readSourceSnapshotRecord(row: SqlRow): SourceSnapshotRecord {
    return {
      snapshotID: readRequiredString(row.snapshot_id, "source_snapshots.snapshot_id"),
      snapshotKind: readRequiredString(
        row.snapshot_kind,
        "source_snapshots.snapshot_kind",
      ) as SourceSnapshotKind,
      allowDelete: readBooleanInt(
        row.allow_delete,
        "source_snapshots.allow_delete",
      ),
      sourceFingerprint: readRequiredString(
        row.source_fingerprint,
        "source_snapshots.source_fingerprint",
      ),
      canonicalRevision: readOptionalString(row.canonical_revision),
      sourceCount: readRequiredNumber(row.source_count, "source_snapshots.source_count"),
      createdAtMs: readRequiredNumber(row.created_at_ms, "source_snapshots.created_at_ms"),
      metadata: parseJson(row.metadata_json),
    };
  }

  private readSourceSnapshotMessageRecord(row: SqlRow): SourceSnapshotMessageRecord {
    return {
      snapshotID: readRequiredString(row.snapshot_id, "source_snapshot_messages.snapshot_id"),
      sourceIndex: readRequiredNumber(row.source_index, "source_snapshot_messages.source_index"),
      hostMessageID: readRequiredString(
        row.host_message_id,
        "source_snapshot_messages.host_message_id",
      ),
      canonicalMessageID: readRequiredString(
        row.canonical_message_id,
        "source_snapshot_messages.canonical_message_id",
      ),
      hostRole: readRequiredString(row.host_role, "source_snapshot_messages.host_role"),
      contentHash: readOptionalString(row.content_hash),
      metadata: parseJson(row.metadata_json),
    };
  }

  private readMarkRecord(row: SqlRow): MarkRecord {
    return {
      markID: readRequiredString(row.mark_id, "marks.mark_id"),
      toolCallMessageID: readRequiredString(
        row.tool_call_message_id,
        "marks.tool_call_message_id",
      ),
      allowDelete: readBooleanInt(row.allow_delete, "marks.allow_delete"),
      markLabel: readOptionalString(row.mark_label),
      sourceSnapshotID: readRequiredString(row.source_snapshot_id, "marks.source_snapshot_id"),
      status: readRequiredString(row.status, "marks.status") as MarkStatus,
      createdAtMs: readRequiredNumber(row.created_at_ms, "marks.created_at_ms"),
      consumedAtMs: readOptionalNumber(row.consumed_at_ms),
      invalidatedAtMs: readOptionalNumber(row.invalidated_at_ms),
      invalidationReason: readOptionalString(row.invalidation_reason),
      metadata: parseJson(row.metadata_json),
    };
  }

  private readCompactionBatchRecord(row: SqlRow): CompactionBatchRecord {
    return {
      batchID: readRequiredString(row.batch_id, "compaction_batches.batch_id"),
      status: readRequiredString(row.status, "compaction_batches.status") as CompactionBatchStatus,
      frozenAtMs: readRequiredNumber(row.frozen_at_ms, "compaction_batches.frozen_at_ms"),
      canonicalRevision: readOptionalString(row.canonical_revision),
      metadata: parseJson(row.metadata_json),
    };
  }

  private readCompactionBatchMarkRecord(row: SqlRow): CompactionBatchMarkRecord {
    return {
      batchID: readRequiredString(row.batch_id, "compaction_batch_marks.batch_id"),
      memberIndex: readRequiredNumber(row.member_index, "compaction_batch_marks.member_index"),
      markID: readRequiredString(row.mark_id, "compaction_batch_marks.mark_id"),
      sourceSnapshotID: readRequiredString(
        row.source_snapshot_id,
        "compaction_batch_marks.source_snapshot_id",
      ),
      allowDelete: readBooleanInt(
        row.allow_delete,
        "compaction_batch_marks.allow_delete",
      ),
    };
  }

  private readCompactionJobRecord(row: SqlRow): CompactionJobRecord {
    return {
      jobID: readRequiredString(row.job_id, "compaction_jobs.job_id"),
      batchID: readRequiredString(row.batch_id, "compaction_jobs.batch_id"),
      markID: readRequiredString(row.mark_id, "compaction_jobs.mark_id"),
      sourceSnapshotID: readRequiredString(
        row.source_snapshot_id,
        "compaction_jobs.source_snapshot_id",
      ),
      status: readRequiredString(row.status, "compaction_jobs.status") as CompactionJobStatus,
      queuedAtMs: readRequiredNumber(row.queued_at_ms, "compaction_jobs.queued_at_ms"),
      startedAtMs: readOptionalNumber(row.started_at_ms),
      finishedAtMs: readOptionalNumber(row.finished_at_ms),
      finalErrorCode: readOptionalString(row.final_error_code),
      finalErrorText: readOptionalString(row.final_error_text),
      metadata: parseJson(row.metadata_json),
    };
  }

  private readCompactionJobAttemptRecord(row: SqlRow): CompactionJobAttemptRecord {
    return {
      jobID: readRequiredString(row.job_id, "compaction_job_attempts.job_id"),
      attemptIndex: readRequiredNumber(
        row.attempt_index,
        "compaction_job_attempts.attempt_index",
      ),
      modelIndex: readRequiredNumber(row.model_index, "compaction_job_attempts.model_index"),
      modelName: readOptionalString(row.model_name),
      status: readRequiredString(row.status, "compaction_job_attempts.status") as CompactionAttemptStatus,
      startedAtMs: readRequiredNumber(
        row.started_at_ms,
        "compaction_job_attempts.started_at_ms",
      ),
      finishedAtMs: readOptionalNumber(row.finished_at_ms),
      errorCode: readOptionalString(row.error_code),
      errorText: readOptionalString(row.error_text),
      replacementID: readOptionalString(row.replacement_id),
      metadata: parseJson(row.metadata_json),
    };
  }

  private readReplacementRecord(row: SqlRow): ReplacementRecord {
    return {
      replacementID: readRequiredString(row.replacement_id, "replacements.replacement_id"),
      allowDelete: readBooleanInt(
        row.allow_delete,
        "replacements.allow_delete",
      ),
      executionMode: readRequiredString(
        row.execution_mode,
        "replacements.execution_mode",
      ) as CompactionExecutionMode,
      sourceSnapshotID: readRequiredString(
        row.source_snapshot_id,
        "replacements.source_snapshot_id",
      ),
      batchID: readOptionalString(row.batch_id),
      jobID: readOptionalString(row.job_id),
      status: readRequiredString(row.status, "replacements.status") as ReplacementStatus,
      contentText: readOptionalString(row.content_text),
      contentJSON: parseJson(row.content_json),
      committedAtMs: readRequiredNumber(row.committed_at_ms, "replacements.committed_at_ms"),
      invalidatedAtMs: readOptionalNumber(row.invalidated_at_ms),
      invalidationKind: readOptionalString(row.invalidation_kind),
      invalidatedByMarkID: readOptionalString(row.invalidated_by_mark_id),
      metadata: parseJson(row.metadata_json),
    };
  }

  private readReplacementMarkLinkRecord(row: SqlRow): ReplacementMarkLinkRecord {
    return {
      replacementID: readRequiredString(
        row.replacement_id,
        "replacement_mark_links.replacement_id",
      ),
      markID: readRequiredString(row.mark_id, "replacement_mark_links.mark_id"),
      linkKind: readRequiredString(
        row.link_kind,
        "replacement_mark_links.link_kind",
      ) as "consumed",
      createdAtMs: readRequiredNumber(
        row.created_at_ms,
        "replacement_mark_links.created_at_ms",
      ),
    };
  }

  private readRuntimeGateObservationRecord(row: SqlRow): RuntimeGateObservationRecord {
    return {
      observationID: readRequiredString(row.observation_id, "runtime_gate_audit.observation_id"),
      gateName: readRequiredString(row.gate_name, "runtime_gate_audit.gate_name") as RuntimeGateName,
      authority: readRequiredString(
        row.authority,
        "runtime_gate_audit.authority",
      ) as RuntimeGateAuthority,
      observedState: readRequiredString(
        row.observed_state,
        "runtime_gate_audit.observed_state",
      ) as RuntimeGateObservedState,
      lockPath: readOptionalString(row.lock_path),
      observedAtMs: readRequiredNumber(row.observed_at_ms, "runtime_gate_audit.observed_at_ms"),
      startedAtMs: readOptionalNumber(row.started_at_ms),
      settledAtMs: readOptionalNumber(row.settled_at_ms),
      activeJobCount: readOptionalNumber(row.active_job_count),
      note: readOptionalString(row.note),
      metadata: parseJson(row.metadata_json),
    };
  }

  private requireRow<T>(row: T | undefined, name: string): T {
    if (row === undefined) {
      throw new Error(`Missing required row: ${name}`);
    }

    return row;
  }
}

type SqlRow = Record<string, unknown>;

function serializeJson(value: JsonValue | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): JsonValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("Expected JSON column to be stored as text.");
  }

  return JSON.parse(value) as JsonValue;
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string for '${fieldName}'.`);
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("Expected optional string column to be text.");
  }

  return value;
}

function readRequiredNumber(value: unknown, fieldName: string): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  throw new Error(`Expected numeric value for '${fieldName}'.`);
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  throw new Error("Expected optional numeric column.");
}

function readBooleanInt(value: unknown, fieldName: string): boolean {
  const numeric = readRequiredNumber(value, fieldName);
  if (numeric !== 0 && numeric !== 1) {
    throw new Error(`Expected boolean-int value for '${fieldName}'.`);
  }

  return numeric === 1;
}
