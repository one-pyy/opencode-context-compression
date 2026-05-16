import type { PluginInput } from "@opencode-ai/plugin";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ProjectedMessageSet } from "../projection/types.js";
import type { RuntimeArtifactRecorder } from "./runtime-artifacts.js";
import {
  acquireSessionFileLock,
  settleAndReleaseSessionFileLock,
  resolvePluginLockDirectory,
} from "./file-lock.js";
import { resolvePluginStateDirectory, resolveSessionDatabasePath } from "./sidecar-layout.js";
import { bootstrapSessionSidecar, openSessionSidecarRepository } from "../state/sidecar-store.js";
import { readPendingCompactions, markCompactionsProcessed } from "../state/sidecar-store/pending-compactions.js";
import { createResultGroupRepository } from "../state/result-group-repository.js";
import { buildCompactionRunInputForMark } from "../compaction/replay-run-input.js";
import {
  computeCompactionAttempt,
  commitCompactionAttempt,
} from "../compaction/runner/internal-runner.js";
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
  const lockDirectory = resolvePluginLockDirectory(pluginInput.directory);

  const stateDirectory = resolvePluginStateDirectory(pluginInput.directory);
  const databasePath = resolveSessionDatabasePath(stateDirectory, sessionId);
  
  await bootstrapSessionSidecar({ databasePath });
  const sidecar = await openSessionSidecarRepository({ databasePath });

  try {
    const pendingCompactions = readPendingCompactions(sidecar.database);

    if (pendingCompactions.length === 0) {
      return;
    }

    const lockResult = await acquireSessionFileLock({
      lockDirectory,
      sessionID: sessionId,
      note: `background compaction batch (${pendingCompactions.length} pending marks)`,
    });
    if (!lockResult.acquired) {
      throw new Error(
        `background compaction lock acquisition failed unexpectedly for session '${sessionId}'`,
      );
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
    
    const processedIds: number[] = [];
    let didFail = false;
    let firstFailureMessage: string | undefined;

    const computeTasks = pendingCompactions.map(async (pending) => {
      const existing = await resultGroupRepo.getCompleteGroup(pending.markId);
      if (existing !== null) {
        return {
          pending,
          kind: "existing" as const,
        };
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
        firstTokenTimeoutMs: runtimeConfig.compressing.firstTokenTimeoutMs,
        streamIdleTimeoutMs: runtimeConfig.compressing.streamIdleTimeoutMs,
        compactionModels: runtimeConfig.models.slice(1),
        maxAttemptsPerModel: runtimeConfig.compressing.maxAttemptsPerModel,
        createdAt: pending.createdAt,
      });

      try {
        const computation = await computeCompactionAttempt(
          {
            inputBuilder,
            transport: safeTransport,
            outputValidator,
            resultGroupRepository: resultGroupRepo,
          },
          runInput,
        );

        return {
          pending,
          kind: "computed" as const,
          runInput,
          computation,
        };
      } catch (error) {
        return {
          pending,
          kind: "failed" as const,
          error,
        };
      }
    });

    const computedResults = await Promise.all(computeTasks);

    for (const item of computedResults) {
      if (item.kind === "existing") {
        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "debug",
          message: "Skipping mark because a committed result group already exists.",
          payload: { markId: item.pending.markId },
        });
        processedIds.push(item.pending.id);
        continue;
      }

      if (item.kind === "failed") {
        didFail = true;
        firstFailureMessage ??= formatError(item.error);
        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "error",
          message: "Background compaction failed for mark.",
          payload: {
            markId: item.pending.markId,
            error: formatError(item.error),
          },
        });
        continue;
      }

      try {
        await commitCompactionAttempt(
          { computation: item.computation, runInput: item.runInput },
          {
            inputBuilder,
            transport: safeTransport,
            outputValidator,
            resultGroupRepository: resultGroupRepo,
          },
        );

        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "info",
          message: "Background compaction completed successfully.",
          payload: { markId: item.pending.markId },
        });
        processedIds.push(item.pending.id);
      } catch (error) {
        didFail = true;
        firstFailureMessage ??= formatError(error);
        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "error",
          message: "Background compaction failed for mark.",
          payload: {
            markId: item.pending.markId,
            error: formatError(error),
          },
        });
      }
    }

    if (processedIds.length > 0) {
      markCompactionsProcessed(sidecar.database, processedIds);
    }

    await settleAndReleaseSessionFileLock({
      lockDirectory,
      sessionID: sessionId,
      status: didFail ? "failed" : "succeeded",
      note: didFail
        ? `background compaction completed with failure: ${firstFailureMessage ?? "unknown error"}`
        : `background compaction completed successfully (${processedIds.length} marks processed)`,
    });
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
