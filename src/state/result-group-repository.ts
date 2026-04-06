import type {
  SessionSidecarRepository,
  SessionSidecarResultGroupRecord,
  SessionSidecarVisibleIDAllocation,
} from "./sidecar-store.js";
import { defineInternalModuleContract } from "../internal/module-contract.js";
import type {
  VisibleIdAllocation,
  VisibleIdAllocationInput,
  VisibleKind,
} from "../identity/visible-id.js";

export interface ResultGroupFragment {
  readonly fragmentIndex: number;
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly replacementText: string;
}

export interface CompleteResultGroup {
  readonly markId: string;
  readonly mode: "compact" | "delete";
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly fragmentCount: number;
  readonly modelName?: string;
  readonly executionMode: string;
  readonly createdAt: string;
  readonly committedAt?: string;
  readonly payloadSha256: string;
  readonly fragments: readonly ResultGroupFragment[];
}

export interface CompleteResultGroupInput {
  readonly markId: string;
  readonly mode: "compact" | "delete";
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly modelName?: string;
  readonly executionMode: string;
  readonly createdAt: string;
  readonly committedAt?: string;
  readonly payloadSha256?: string;
  readonly fragments: readonly Omit<ResultGroupFragment, "fragmentIndex">[];
}

export interface ResultGroupRepository {
  upsertCompleteGroup(input: CompleteResultGroupInput): Promise<void>;
  getCompleteGroup(markId: string): Promise<CompleteResultGroup | null>;
  listGroupsOverlappingRange(
    startSeq: number,
    endSeq: number,
  ): Promise<readonly CompleteResultGroup[]>;
  allocateVisibleId(
    input: VisibleIdAllocationInput,
  ): Promise<VisibleIdAllocation>;
  getVisibleId(canonicalId: string): Promise<VisibleIdAllocation | null>;
}

export const RESULT_GROUP_REPOSITORY_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "ResultGroupRepository",
    inputs: [
      "CompleteResultGroupInput",
      "VisibleIdAllocationInput",
      "source sequence range",
    ],
    outputs: ["CompleteResultGroup", "VisibleIdAllocation", "null"],
    mutability: "mutable",
    reads: [
      "state/<session-id>.db result_groups",
      "state/<session-id>.db result_fragments",
      "state/<session-id>.db visible_sequence_allocations",
    ],
    writes: [
      "state/<session-id>.db result_groups",
      "state/<session-id>.db result_fragments",
      "state/<session-id>.db visible_sequence_allocations",
    ],
    errorTypes: ["RESULT_GROUP_INCOMPLETE", "visible-id kind conflict"],
    idempotency:
      "Result-group upsert is idempotent only for byte-identical committed content; visible-id allocation is idempotent for the same canonicalId and visibleKind.",
    dependencyDirection: {
      inboundFrom: ["ProjectionBuilder", "CompactionRunner", "CanonicalIdentityService"],
      outboundTo: [],
    },
  });

export function createResultGroupRepository(
  repository: SessionSidecarRepository,
): ResultGroupRepository {
  return {
    async upsertCompleteGroup(input) {
      repository.upsertResultGroup({
        markID: input.markId,
        mode: input.mode,
        sourceStartSeq: input.sourceStartSeq,
        sourceEndSeq: input.sourceEndSeq,
        modelName: input.modelName,
        executionMode: input.executionMode,
        createdAt: input.createdAt,
        committedAt: input.committedAt,
        payloadSha256: input.payloadSha256,
        fragments: input.fragments.map((fragment) => ({
          sourceStartSeq: fragment.sourceStartSeq,
          sourceEndSeq: fragment.sourceEndSeq,
          replacementText: fragment.replacementText,
        })),
      });
    },
    async getCompleteGroup(markId) {
      const record = repository.readResultGroup(markId);
      return record ? mapResultGroupRecord(record) : null;
    },
    async listGroupsOverlappingRange(startSeq, endSeq) {
      return repository
        .listResultGroups()
        .filter(
          (record) =>
            record.sourceStartSeq <= endSeq && record.sourceEndSeq >= startSeq,
        )
        .map(mapResultGroupRecord);
    },
    async allocateVisibleId(input) {
      return mapVisibleIdAllocation(
        repository.allocateVisibleID({
          canonicalID: input.canonicalId,
          visibleKind: input.visibleKind,
          allocatedAt: input.allocatedAt,
        }),
      );
    },
    async getVisibleId(canonicalId) {
      const allocation = repository.readVisibleID(canonicalId);
      return allocation ? mapVisibleIdAllocation(allocation) : null;
    },
  } satisfies ResultGroupRepository;
}

function mapResultGroupRecord(
  record: SessionSidecarResultGroupRecord,
): CompleteResultGroup {
  return Object.freeze({
    markId: record.markID,
    mode: record.mode,
    sourceStartSeq: record.sourceStartSeq,
    sourceEndSeq: record.sourceEndSeq,
    fragmentCount: record.fragmentCount,
    modelName: record.modelName,
    executionMode: record.executionMode,
    createdAt: record.createdAt,
    committedAt: record.committedAt,
    payloadSha256: record.payloadSha256,
    fragments: Object.freeze(
      record.fragments.map((fragment) => ({
        fragmentIndex: fragment.fragmentIndex,
        sourceStartSeq: fragment.sourceStartSeq,
        sourceEndSeq: fragment.sourceEndSeq,
        replacementText: fragment.replacementText,
      } satisfies ResultGroupFragment)),
    ),
  });
}

function mapVisibleIdAllocation(
  allocation: SessionSidecarVisibleIDAllocation,
): VisibleIdAllocation {
  return Object.freeze({
    canonicalId: allocation.canonicalID,
    visibleKind: allocation.visibleKind as VisibleKind,
    visibleSeq: allocation.visibleSeq,
    visibleBase62: allocation.visibleBase62,
    assignedVisibleId: allocation.assignedVisibleID,
    allocatedAt: allocation.allocatedAt,
  });
}
