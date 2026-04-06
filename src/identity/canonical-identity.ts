import { defineInternalModuleContract } from "../internal/module-contract.js";
import type { CanonicalHostMessage } from "../history/history-replay-reader.js";
import type {
  VisibleIdAllocation,
  VisibleIdAllocationInput,
  VisibleKind,
} from "./visible-id.js";

interface VisibleIdAllocationStore {
  allocateVisibleId(
    input: VisibleIdAllocationInput,
  ): Promise<VisibleIdAllocation> | VisibleIdAllocation;
}

export interface CanonicalIdentityService {
  getCanonicalId(message: CanonicalHostMessage): string;
  allocateVisibleId(
    canonicalId: string,
    visibleKind: VisibleKind,
  ): Promise<VisibleIdAllocation>;
}

export const CANONICAL_IDENTITY_SERVICE_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "CanonicalIdentityService",
    inputs: ["CanonicalHostMessage", "canonicalId", "VisibleKind"],
    outputs: ["canonicalId", "VisibleIdAllocation"],
    mutability: "mutable",
    reads: ["message.info.id", "visible_sequence_allocations"],
    writes: ["visible_sequence_allocations"],
    errorTypes: ["SESSION_NOT_READY", "visible-id kind conflict"],
    idempotency:
      "Canonical ID derivation is pure; visible-id allocation is idempotent for the same canonicalId and visibleKind.",
    dependencyDirection: {
      inboundFrom: ["ProjectionBuilder"],
      outboundTo: ["ResultGroupRepository"],
    },
  });

export function createCanonicalIdentityService(options: {
  readonly visibleIds: VisibleIdAllocationStore;
  readonly allocateAt?: () => string;
}): CanonicalIdentityService {
  return {
    getCanonicalId(message) {
      const canonicalId = message.info.id.trim();
      if (canonicalId.length === 0) {
        throw new Error(
          "CanonicalIdentityService requires host messages to expose a non-empty info.id.",
        );
      }

      return canonicalId;
    },
    async allocateVisibleId(canonicalId, visibleKind) {
      return options.visibleIds.allocateVisibleId({
        canonicalId,
        visibleKind,
        allocatedAt: options.allocateAt?.() ?? new Date().toISOString(),
      });
    },
  } satisfies CanonicalIdentityService;
}
