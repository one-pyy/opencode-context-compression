import type {
  CompactionExecutionMode,
  JsonValue,
  MarkRecord,
  MarkStatus,
  ReplacementResultGroupItemRecord,
  ReplacementResultGroupMarkLinkRecord,
  ReplacementResultGroupRecord,
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
  readonly firstSeenAtMs: number;
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
  private readonly runtimeStates = new Map<
    string,
    Partial<Pick<MarkSpec, "status" | "consumedAtMs" | "invalidatedAtMs" | "invalidationReason">>
  >();
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
    for (const [index, message] of input.messages.entries()) {
      this.hostMessages.set(message.hostMessageID, {
        hostMessageID: message.hostMessageID,
        canonicalMessageID: message.canonicalMessageID,
        role: message.role,
        firstSeenAtMs: index,
      });
    }
  }

  listHostMessages(): Array<{
    hostMessageID: string;
    canonicalMessageID: string;
    role: string;
    firstSeenAtMs: number;
  }> {
    return [...this.hostMessages.values()].sort(
      (left, right) => left.firstSeenAtMs - right.firstSeenAtMs,
    );
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

  listMarkSourceMessages(markID: string): SourceSnapshotMessageRecord[] {
    const mark = this.marks.find((candidate) => candidate.markID === markID);
    return mark === undefined
      ? []
      : this.buildSourceMessages(`${mark.markID}:snapshot`, mark.sourceMessageIDs);
  }

  upsertMarkRuntimeState(input: {
    readonly markID: string;
    readonly status: MarkStatus;
    readonly consumedAtMs?: number;
    readonly invalidatedAtMs?: number;
    readonly invalidationReason?: string;
  }): MarkRecord | undefined {
    this.runtimeStates.set(input.markID, {
      status: input.status,
      consumedAtMs: input.consumedAtMs,
      invalidatedAtMs: input.invalidatedAtMs,
      invalidationReason: input.invalidationReason,
    });
    return this.getMark(input.markID);
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

  listSourceSnapshotMessages(snapshotID: string): SourceSnapshotMessageRecord[] {
    const mark = this.marks.find(
      (candidate) => `${candidate.markID}:snapshot` === snapshotID,
    );
    if (mark !== undefined) {
      return this.buildSourceMessages(snapshotID, mark.sourceMessageIDs);
    }

    const replacement = this.replacements.find(
      (candidate) => `${candidate.replacementID}:snapshot` === snapshotID,
    );
    return replacement === undefined
      ? []
      : this.buildSourceMessages(snapshotID, replacement.sourceMessageIDs);
  }

  getReplacement(replacementID: string): ReplacementRecord | undefined {
    const replacement = this.replacements.find(
      (candidate) => candidate.replacementID === replacementID,
    );
    return replacement ? this.buildReplacementRecord(replacement) : undefined;
  }

  getReplacementResultGroup(markID: string): ReplacementResultGroupRecord | undefined {
    const replacement = this.replacements
      .filter(
        (candidate) =>
          candidate.status !== "invalidated" &&
          candidate.invalidatedAtMs === undefined &&
          (candidate.markIDs ?? []).includes(markID),
      )
      .sort(
        (left, right) =>
          (right.committedAtMs ?? 0) - (left.committedAtMs ?? 0) ||
          right.replacementID.localeCompare(left.replacementID),
      )[0];
    if (replacement === undefined) {
      return undefined;
    }

    return {
      resultGroupID: replacement.replacementID,
      primaryMarkID: markID,
      completeness:
        replacement.status === "invalidated" || replacement.invalidatedAtMs !== undefined
          ? "incomplete"
          : "complete",
      executionMode: replacement.executionMode,
      batchID: undefined,
      jobID: undefined,
      sourceSnapshotID: `${replacement.replacementID}:snapshot`,
      itemCount: 1,
      committedAtMs: replacement.committedAtMs ?? 0,
      invalidatedAtMs: replacement.invalidatedAtMs,
      invalidationKind: replacement.invalidationKind,
      invalidatedByMarkID: replacement.invalidatedByMarkID,
      metadata: undefined,
    };
  }

  listReplacementResultGroupItems(markID: string): ReplacementResultGroupItemRecord[] {
    const replacement = this.findLatestCommittedReplacementForMark(markID);
    if (replacement === undefined) {
      return [];
    }

    return [
      {
        resultGroupID: replacement.replacementID,
        itemIndex: 0,
        replacementID: replacement.replacementID,
        sourceSnapshotID: replacement.sourceSnapshotID,
        contentText: replacement.contentText,
        contentJSON: replacement.contentJSON,
        metadata: replacement.metadata,
      },
    ];
  }

  listReplacementResultGroupMarkLinks(markID: string): ReplacementResultGroupMarkLinkRecord[] {
    const replacement = this.findLatestCommittedReplacementForMark(markID);
    if (replacement === undefined) {
      return [];
    }

    return (this.replacements.find((candidate) => candidate.replacementID === replacement.replacementID)?.markIDs ?? []).map(
      (linkedMarkID) => ({
        resultGroupID: replacement.replacementID,
        markID: linkedMarkID,
        linkKind: linkedMarkID === markID ? "primary" : "consumed",
        createdAtMs: replacement.committedAtMs,
      }),
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

  findLatestCommittedReplacementForMark(markID: string): ReplacementRecord | undefined {
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
    const runtimeState = this.runtimeStates.get(spec.markID);
    return {
      markID: spec.markID,
      toolCallMessageID: spec.toolCallMessageID,
      allowDelete: spec.allowDelete,
      markLabel: undefined,
      sourceSnapshotID: `${spec.markID}:snapshot`,
      status: runtimeState?.status ?? spec.status ?? "active",
      createdAtMs: spec.createdAtMs ?? 0,
      consumedAtMs: runtimeState?.consumedAtMs ?? spec.consumedAtMs,
      invalidatedAtMs: runtimeState?.invalidatedAtMs ?? spec.invalidatedAtMs,
      invalidationReason:
        runtimeState?.invalidationReason ?? spec.invalidationReason,
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
