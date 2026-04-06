import { requireCompactionTransport } from "../../runtime/compaction-transport.js";
import { validateCompactionTransportPayload } from "../transport/validation.js";
import type {
  CompactionTransport,
  CompactionTransportRequest,
  ValidatedCompactionTransportPayload,
} from "../transport/types.js";

export interface CompactionRunnerDependencies {
  readonly transport?: CompactionTransport;
}

export interface CompactionRunner {
  run(
    request: CompactionTransportRequest,
  ): Promise<ValidatedCompactionTransportPayload>;
}

export function createCompactionRunner(
  dependencies: CompactionRunnerDependencies,
): CompactionRunner {
  return {
    async run(request) {
      return executeCompactionAttempt(dependencies, request);
    },
  } satisfies CompactionRunner;
}

export async function executeCompactionAttempt(
  dependencies: CompactionRunnerDependencies,
  request: CompactionTransportRequest,
): Promise<ValidatedCompactionTransportPayload> {
  const transport = requireCompactionTransport(dependencies.transport);
  const rawPayload = await transport.invoke(request);
  return validateCompactionTransportPayload(rawPayload, request);
}
