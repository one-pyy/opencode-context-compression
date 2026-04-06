import { CompactionTransportConfigurationError } from "../compaction/transport/errors.js";
import type { CompactionTransport } from "../compaction/transport/types.js";

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
