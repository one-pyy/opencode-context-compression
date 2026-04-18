import type { ChatParamsSchedulerDispatchResult } from "./chat-params-scheduler.js";
import { resolvePluginStateDirectory, resolveSessionDatabasePath } from "./sidecar-layout.js";
import { bootstrapSessionSidecar, openSessionSidecarRepository } from "../state/sidecar-store.js";
import { writePendingCompaction } from "../state/sidecar-store/pending-compactions.js";

export interface CompactionDispatcherOptions {
  readonly pluginDirectory: string;
}

export function createCompactionDispatcher(
  options: CompactionDispatcherOptions,
) {
  return async (input: {
    readonly sessionId: string;
    readonly eligibleMarkIds: readonly string[];
  }): Promise<ChatParamsSchedulerDispatchResult> => {
    if (input.eligibleMarkIds.length === 0) {
      return {
        scheduled: false,
        reason: "no eligible marks to dispatch",
      };
    }

    const stateDirectory = resolvePluginStateDirectory(options.pluginDirectory);
    const databasePath = resolveSessionDatabasePath(stateDirectory, input.sessionId);
    
    await bootstrapSessionSidecar({ databasePath });
    const sidecar = await openSessionSidecarRepository({ databasePath });

    try {
      for (const markId of input.eligibleMarkIds) {
        writePendingCompaction(sidecar.database, markId);
      }

      return {
        scheduled: true,
        reason: "froze the current replay-derived mark set for compaction dispatch",
        dispatchedBatch: Object.freeze({
          markIds: Object.freeze([...input.eligibleMarkIds]),
          markCount: input.eligibleMarkIds.length,
          dispatchedAt: new Date().toISOString(),
        }),
      };
    } finally {
      sidecar.close();
    }
  };
}
