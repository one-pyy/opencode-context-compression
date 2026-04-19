import type { PluginInput } from "@opencode-ai/plugin";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ProjectedMessageSet } from "../projection/types.js";
import type { RuntimeArtifactRecorder } from "./runtime-artifacts.js";
import { resolvePluginStateDirectory, resolveSessionDatabasePath } from "./sidecar-layout.js";
import { bootstrapSessionSidecar, openSessionSidecarRepository } from "../state/sidecar-store.js";
import { readPendingCompactions, markCompactionsProcessed } from "../state/sidecar-store/pending-compactions.js";
import { createResultGroupRepository } from "../state/result-group-repository.js";
import { buildCompactionRunInputForMark } from "../compaction/replay-run-input.js";
import { createContractLevelCompactionRunner } from "../compaction/runner.js";
import { createCompactionInputBuilder } from "../compaction/input-builder.js";
import { createOutputValidator } from "../compaction/output-validation.js";
import { createDirectLLMCompactionTransport } from "../compaction/transport/direct-llm.js";

export interface BackgroundCompactionExecutorOptions {
  readonly pluginInput: PluginInput;
  readonly runtimeConfig: LoadedRuntimeConfig;
  readonly runtimeArtifacts: RuntimeArtifactRecorder;
  readonly sessionId: string;
  readonly projectionState: ProjectedMessageSet;
}

export async function executeBackgroundCompactions(
  options: BackgroundCompactionExecutorOptions,
): Promise<void> {
  const { sessionId, projectionState, pluginInput, runtimeConfig, runtimeArtifacts } = options;

  const stateDirectory = resolvePluginStateDirectory(pluginInput.directory);
  const databasePath = resolveSessionDatabasePath(stateDirectory, sessionId);
  
  await bootstrapSessionSidecar({ databasePath });
  const sidecar = await openSessionSidecarRepository({ databasePath });

  try {
    const pendingCompactions = readPendingCompactions(sidecar.database);
    
    if (pendingCompactions.length === 0) {
      return;
    }

    await runtimeArtifacts.writeDiagnostic({
      sessionID: sessionId,
      scope: "background-compaction",
      severity: "info",
      message: "Found pending compactions for session.",
      payload: {
        pendingCompactionCount: pendingCompactions.length,
        projectionMarkCount: projectionState.state.markTree.marks.length,
      },
    });

    const resultGroupRepo = createResultGroupRepository(sidecar);
    
    const transport = runtimeConfig.transport ?? createDirectLLMCompactionTransport(pluginInput, {
      runtimeArtifacts,
    });
    const inputBuilder = createCompactionInputBuilder();
    const outputValidator = createOutputValidator();
    
    const safeTransport: import("./compaction-transport.js").SafeTransportAdapter = {
      async execute(request) {
        return Object.freeze({
          rawPayload: await transport.invoke(request),
        });
      },
    };
    
    const runner = createContractLevelCompactionRunner({
      inputBuilder,
      transport: safeTransport,
      outputValidator,
      resultGroupRepository: resultGroupRepo,
    });

    const processedIds: number[] = [];

    for (const pending of pendingCompactions) {
      try {
        const existing = await resultGroupRepo.getCompleteGroup(pending.markId);
        if (existing !== null) {
          await runtimeArtifacts.writeDiagnostic({
            sessionID: sessionId,
            scope: "background-compaction",
            severity: "debug",
            message: "Skipping mark because a committed result group already exists.",
            payload: { markId: pending.markId },
          });
          processedIds.push(pending.id);
          continue;
        }

        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "info",
          message: "Executing background compaction for mark.",
          payload: { markId: pending.markId },
        });

        const runInput = buildCompactionRunInputForMark({
          sessionId,
          state: projectionState.state,
          markId: pending.markId,
          model: runtimeConfig.models[0],
          promptText: runtimeConfig.promptText,
          timeoutMs: runtimeConfig.compressing.timeoutMs,
          compactionModels: runtimeConfig.models.slice(1),
          maxAttemptsPerModel: 2,
          createdAt: pending.createdAt,
        });

        await runner.run(runInput);
        
        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "info",
          message: "Background compaction completed successfully.",
          payload: { markId: pending.markId },
        });
        processedIds.push(pending.id);
      } catch (error) {
        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "error",
          message: "Background compaction failed for mark.",
          payload: {
            markId: pending.markId,
            error: formatError(error),
          },
        });
      }
    }

    if (processedIds.length > 0) {
      markCompactionsProcessed(sidecar.database, processedIds);
    }
  } finally {
    sidecar.close();
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
