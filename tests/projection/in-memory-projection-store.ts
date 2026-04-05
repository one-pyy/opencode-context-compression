import type {
  CompactionExecutionMode,
  JsonValue,
  MarkRecord,
  MarkStatus,
  ReplacementMarkLinkRecord,
  ReplacementRecord,
  ReplacementStatus,
  SourceSnapshotMessageRecord,
  SqliteSessionStateStore,
  SyncCanonicalHostMessagesInput,
  VisibleSequenceAssignment,
} from "../../src/state/store.js";

interface MarkSpec {
  readonly markID: string;
  readonly toolCallMessageID: string;
  readonly allowDelete: boolean;
  readonly sourceMessageIDs: readonly string[];
  readonly status?: MarkStatus;
  readonly createdAtMs?: number;
  readonly consumedAtMs?: number;
  readonly invalidatedAtMs?: number;
  readonly invalidationReason?: string;
}

interface ReplacementSpec {
  readonly replacementID: string;
  readonly allowDelete: boolean;
  readonly executionMode: CompactionExecutionMode;
  readonly sourceMessageIDs: readonly string[];
  readonly markIDs?: readonly string[];
  readonly status?: ReplacementStatus;
  readonly committedAtMs?: number;
  readonly contentText?: string;
  readonly contentJSON?: unknown;
  readonly invalidatedAtMs?: number;
  readonly invalidationKind?: string;
  readonly invalidatedByMarkID?: string;
}

interface HostMessageSnapshot {
  readonly hostMessageID: string;
  readonly canonicalMessageID: string;
  readonly role: string;
}

export function createInMemoryProjectionStoreFixture(input?: {
  readonly marks?: readonly MarkSpec[];
  readonly replacements?: readonly ReplacementSpec[];
}): SqliteSessionStateStore {
  return new InMemoryProjectionStoreFixture(input) as unknown as SqliteSessionStateStore;
}

class InMemoryProjectionStoreFixture {
  private readonly marks: readonly MarkSpec[];
  private readonly replacements: readonly ReplacementSpec[];
  private readonly visibleAssignments = new Map<string, VisibleSequenceAssignment>();
  private readonly hostMessages = new Map<string, HostMessageSnapshot>();
  private nextVisibleSeq = 1;

  constructor(input?: {
    readonly marks?: readonly MarkSpec[];
    readonly replacements?: readonly ReplacementSpec[];
  }) {
    this.marks = input?.marks ?? [];
    this.replacements = input?.replacements ?? [];
  }

  close(): void {}

  syncCanonicalHostMessages(input: SyncCanonicalHostMessagesInput): void {
    this.hostMessages.clear();
    for (const message of input.messages) {
      this.hostMessages.set(message.hostMessageID, {
        hostMessageID: message.hostMessageID,
        canonicalMessageID: message.canonicalMessageID,
        role: message.role,
      });
    }
  }

  ensureVisibleSequenceAssignment(input: {
    readonly hostMessageID: string;
    readonly visibleChecksum?: string;
  }): VisibleSequenceAssignment {
    const existing = this.visibleAssignments.get(input.hostMessageID);
    if (existing !== undefined) {
      return {
        hostMessageID: input.hostMessageID,
        visibleSeq: existing.visibleSeq,
        visibleChecksum: input.visibleChecksum ?? existing.visibleChecksum,
      };
    }

    const created = {
      hostMessageID: input.hostMessageID,
      visibleSeq: this.nextVisibleSeq++,
      visibleChecksum: input.visibleChecksum,
    } satisfies VisibleSequenceAssignment;
    this.visibleAssignments.set(input.hostMessageID, created);
    return created;
  }

  getMark(markID: string): MarkRecord | undefined {
    const spec = this.marks.find((candidate) => candidate.markID === markID);
    return spec ? this.buildMarkRecord(spec) : undefined;
  }

  getMarkByToolCallMessageID(toolCallMessageID: string): MarkRecord | undefined {
    const spec = this.marks.find(
      (candidate) => candidate.toolCallMessageID === toolCallMessageID,
    );
    return spec ? this.buildMarkRecord(spec) : undefined;
  }

  listMarks(options?: { readonly status?: MarkStatus }): MarkRecord[] {
    return this.marks
      .map((mark) => this.buildMarkRecord(mark))
      .filter((mark) => options?.status === undefined || mark.status === options.status);
  }

  listReplacementSourceMessages(
    replacementID: string,
  ): SourceSnapshotMessageRecord[] {
    const replacement = this.replacements.find(
      (candidate) => candidate.replacementID === replacementID,
    );
    return replacement === undefined
      ? []
      : this.buildSourceMessages(
          `${replacement.replacementID}:snapshot`,
          replacement.sourceMessageIDs,
        );
  }

  listReplacementMarkLinks(replacementID: string): ReplacementMarkLinkRecord[] {
    const replacement = this.replacements.find(
      (candidate) => candidate.replacementID === replacementID,
    );
    if (replacement === undefined) {
      return [];
    }

    return (replacement?.markIDs ?? []).map((markID) => ({
      replacementID,
      markID,
      linkKind: "consumed",
      createdAtMs: replacement.committedAtMs ?? 0,
    }));
  }

  findFirstCommittedReplacementForMark(markID: string): ReplacementRecord | undefined {
    const candidate = this.replacements
      .filter(
        (replacement) =>
          replacement.status !== "invalidated" &&
          replacement.invalidatedAtMs === undefined &&
          (replacement.markIDs ?? []).includes(markID),
      )
      .sort(
        (left, right) =>
          (right.committedAtMs ?? 0) - (left.committedAtMs ?? 0) ||
          right.replacementID.localeCompare(left.replacementID),
      )[0];
    return candidate ? this.buildReplacementRecord(candidate) : undefined;
  }

  private buildMarkRecord(spec: MarkSpec): MarkRecord {
    return {
      markID: spec.markID,
      toolCallMessageID: spec.toolCallMessageID,
      allowDelete: spec.allowDelete,
      markLabel: undefined,
      sourceSnapshotID: `${spec.markID}:snapshot`,
      status: spec.status ?? "active",
      createdAtMs: spec.createdAtMs ?? 0,
      consumedAtMs: spec.consumedAtMs,
      invalidatedAtMs: spec.invalidatedAtMs,
      invalidationReason: spec.invalidationReason,
      metadata: undefined,
    };
  }

  private buildReplacementRecord(spec: ReplacementSpec): ReplacementRecord {
    return {
      replacementID: spec.replacementID,
      allowDelete: spec.allowDelete,
      executionMode: spec.executionMode,
      sourceSnapshotID: `${spec.replacementID}:snapshot`,
      batchID: undefined,
      jobID: undefined,
      status: spec.status ?? "committed",
      contentText: spec.contentText,
      contentJSON: spec.contentJSON as JsonValue | undefined,
      committedAtMs: spec.committedAtMs ?? 0,
      invalidatedAtMs: spec.invalidatedAtMs,
      invalidationKind: spec.invalidationKind,
      invalidatedByMarkID: spec.invalidatedByMarkID,
      metadata: undefined,
    };
  }

  private buildSourceMessages(
    snapshotID: string,
    sourceMessageIDs: readonly string[],
  ): SourceSnapshotMessageRecord[] {
    return sourceMessageIDs.map((hostMessageID, sourceIndex) => {
      const hostMessage = this.hostMessages.get(hostMessageID);
      if (hostMessage === undefined) {
        throw new Error(`Missing host message '${hostMessageID}' in projection store fixture.`);
      }

      return {
        snapshotID,
        sourceIndex,
        hostMessageID,
        canonicalMessageID: hostMessage.canonicalMessageID,
        hostRole: hostMessage.role,
        contentHash: undefined,
        metadata: undefined,
      };
    });
  }
}
