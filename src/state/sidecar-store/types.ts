export interface BootstrapSessionSidecarOptions {
  readonly databasePath: string;
}

export interface RebuildSessionSidecarFromReplayOptions {
  readonly databasePath: string;
  readonly replayState: SessionSidecarReplayState;
}

export interface ReplayVisibleMessage {
  readonly canonicalID: string;
  readonly visibleKind: string;
  readonly allocatedAt: string;
}

export interface ReplayResultFragment {
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly replacementText: string;
}

export interface ReplayResultGroup {
  readonly markID: string;
  readonly mode: "compact" | "delete";
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly modelName?: string;
  readonly executionMode: string;
  readonly createdAt: string;
  readonly committedAt?: string;
  readonly payloadSha256?: string;
  readonly fragments: readonly ReplayResultFragment[];
}

export interface SessionSidecarReplayState {
  readonly visibleMessages: readonly ReplayVisibleMessage[];
  readonly resultGroups: readonly ReplayResultGroup[];
}

export interface SessionSidecarVisibleIDAllocation {
  readonly canonicalID: string;
  readonly visibleSeq: number;
  readonly visibleBase62: string;
  readonly allocatedAt: string;
}

export interface SessionSidecarResultFragment {
  readonly fragmentIndex: number;
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly replacementText: string;
}

export interface SessionSidecarResultGroupRecord {
  readonly markID: string;
  readonly mode: "compact" | "delete";
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly fragmentCount: number;
  readonly modelName?: string;
  readonly executionMode: string;
  readonly createdAt: string;
  readonly committedAt?: string;
  readonly payloadSha256: string;
  readonly fragments: readonly SessionSidecarResultFragment[];
}

export interface SessionSidecarResultGroupWrite {
  readonly markID: string;
  readonly mode: "compact" | "delete";
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly modelName?: string;
  readonly executionMode: string;
  readonly createdAt: string;
  readonly committedAt?: string;
  readonly payloadSha256?: string;
  readonly fragments: readonly ReplayResultFragment[];
}

export interface AllocateVisibleIDOptions {
  readonly canonicalID: string;
  readonly visibleKind: string;
  readonly allocatedAt: string;
}

export interface SessionSidecarResultGroupUpsertResult {
  readonly status: "inserted" | "unchanged";
  readonly resultGroup: SessionSidecarResultGroupRecord;
}

export interface OpenSessionSidecarRepositoryOptions {
  readonly databasePath: string;
}

export interface SessionSidecarRepository {
  allocateVisibleID(
    options: AllocateVisibleIDOptions,
  ): SessionSidecarVisibleIDAllocation;
  readVisibleID(
    canonicalID: string,
  ): SessionSidecarVisibleIDAllocation | undefined;
  listVisibleIDs(): readonly SessionSidecarVisibleIDAllocation[];
  createResultGroup(
    resultGroup: SessionSidecarResultGroupWrite,
  ): SessionSidecarResultGroupRecord;
  readResultGroup(
    markID: string,
  ): SessionSidecarResultGroupRecord | undefined;
  getResultGroupByMarkID(
    markID: string,
  ): SessionSidecarResultGroupRecord | undefined;
  listResultGroups(): readonly SessionSidecarResultGroupRecord[];
  upsertResultGroup(
    resultGroup: SessionSidecarResultGroupWrite,
  ): SessionSidecarResultGroupUpsertResult;
  listPendingMarkIds(): readonly string[];
  close(): void;
}
