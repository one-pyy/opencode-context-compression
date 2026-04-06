import { CompactionTransportConfigurationError } from "../compaction/transport/errors.js";
import type { CompactionTransport } from "../compaction/transport/types.js";
import type {
  CompactionRequest,
  TransportResponse,
} from "../compaction/types.js";
import { defineInternalModuleContract } from "../internal/module-contract.js";

export interface SafeTransportAdapter {
  execute(request: CompactionRequest): Promise<TransportResponse>;
}

export const SAFE_TRANSPORT_ADAPTER_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "SafeTransportAdapter",
    inputs: ["CompactionRequest"],
    outputs: ["TransportResponse"],
    mutability: "read-only",
    reads: ["injected hermetic transport seam"],
    writes: ["transport call recording inside injected transport implementation"],
    errorTypes: [
      "TRANSPORT_TIMEOUT",
      "CompactionTransportRetryableError",
      "CompactionTransportFatalError",
      "CompactionTransportAbortedError",
    ],
    idempotency:
      "Not inherently idempotent; transport side effects depend on the injected safe transport script.",
    dependencyDirection: {
      inboundFrom: ["CompactionRunner"],
      outboundTo: [],
    },
  });

export function requireCompactionTransport(
  transport: CompactionTransport | undefined,
): CompactionTransport {
  if (transport !== undefined) {
    return transport;
  }

  throw new CompactionTransportConfigurationError(
    "Compaction execution requires an injected safe transport adapter. No default live executor is available in this repo.",
  );
}

export function createSafeTransportAdapter(
  transport: CompactionTransport | undefined,
): SafeTransportAdapter {
  return {
    async execute(request) {
      return Object.freeze({
        rawPayload: await requireCompactionTransport(transport).invoke(request),
      });
    },
  } satisfies SafeTransportAdapter;
}
