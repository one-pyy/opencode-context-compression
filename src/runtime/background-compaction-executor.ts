import type { PluginInput } from "@opencode-ai/plugin";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ProjectedMessageSet, MarkTreeNode } from "../projection/types.js";
import type { RuntimeArtifactRecorder } from "./runtime-artifacts.js";
import {
  acquireSessionFileLock,
  settleAndReleaseSessionFileLock,
  resolvePluginLockDirectory,
} from "./file-lock.js";
import { resolvePluginStateDirectory, resolveSessionDatabasePath } from "./sidecar-layout.js";
import { bootstrapSessionSidecar, openSessionSidecarRepository } from "../state/sidecar-store.js";
import { createResultGroupRepository } from "../state/result-group-repository.js";
import { createCompactionFailureRepository } from "../state/compaction-failure-repository.js";
import { buildCompactionRunInputForMark } from "../compaction/replay-run-input.js";
import {
  computeCompactionAttempt,
  commitCompactionAttempt,
} from "../compaction/runner/internal-runner.js";
import { createCompactionInputBuilder } from "../compaction/input-builder.js";
import { createOutputValidator } from "../compaction/output-validation.js";
import { createDirectLLMCompactionTransport } from "../compaction/transport/direct-llm.js";
import type { ToastService } from "../services/toast-service.js";
import { getCompactionModelChainExhaustionInfo } from "../compaction/errors.js";

export interface BackgroundCompactionExecutorOptions {
  readonly pluginInput: PluginInput;
  readonly runtimeConfig: LoadedRuntimeConfig;
  readonly runtimeArtifacts: RuntimeArtifactRecorder;
  readonly sessionId: string;
  readonly projectionState: ProjectedMessageSet;
  readonly toastService?: ToastService;
}

interface EligibleMark {
  readonly markId: string;
  readonly sourceMessageId: string;
  readonly createdAt: string;
}

function collectEligibleMarks(projectionState: ProjectedMessageSet): EligibleMark[] {
  const resultGroupMarkIds = new Set(
    projectionState.state.resultGroups.map((group) => group.markId),
  );
  const eligible: EligibleMark[] = [];
  const now = new Date().toISOString();

  function walk(nodes: readonly MarkTreeNode[]): void {
    for (const node of nodes) {
      if (resultGroupMarkIds.has(node.markId)) {
        continue;
      }

      eligible.push({
        markId: node.markId,
        sourceMessageId: node.sourceMessageId,
        createdAt: now,
      });
      walk(node.children);
    }
  }

  walk(projectionState.state.markTree.marks);
  return eligible;
}

export async function executeBackgroundCompactions(
  options: BackgroundCompactionExecutorOptions,
): Promise<void> {
  const { sessionId, projectionState, pluginInput, runtimeConfig, runtimeArtifacts, toastService } = options;
  const lockDirectory = resolvePluginLockDirectory(pluginInput.directory);

  const stateDirectory = resolvePluginStateDirectory(pluginInput.directory);
  const databasePath = resolveSessionDatabasePath(stateDirectory, sessionId);

  await bootstrapSessionSidecar({ databasePath });
  const sidecar = await openSessionSidecarRepository({ databasePath });

  try {
    const failureRepo = createCompactionFailureRepository(sidecar);
    const maxFailureCount = runtimeConfig.compressing.maxFailureCount;
    const eligibleMarks = collectEligibleMarks(projectionState).filter(
      (mark) =>
        (failureRepo.getFailure(mark.markId)?.failureCount ?? 0) <
        maxFailureCount,
    );

    if (eligibleMarks.length === 0) {
      return;
    }

    const lockResult = await acquireSessionFileLock({
      lockDirectory,
      sessionID: sessionId,
      note: `background compaction batch (${eligibleMarks.length} eligible marks)`,
    });
    if (!lockResult.acquired) {
      throw new Error(
        `background compaction lock acquisition failed unexpectedly for session '${sessionId}'`,
      );
    }

    toastService?.showCompressionStarted().catch(() => {});

    await runtimeArtifacts.writeDiagnostic({
      sessionID: sessionId,
      scope: "background-compaction",
      severity: "info",
      message: "Found eligible marks for background compaction.",
      payload: {
        eligibleMarkCount: eligibleMarks.length,
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

    let didFail = false;
    let firstFailureMessage: string | undefined;

    const computeTasks = eligibleMarks.map(async (eligible) => {
      const existing = await resultGroupRepo.getCompleteGroup(eligible.markId);
      if (existing !== null) {
        return {
          eligible,
          kind: "existing" as const,
        };
      }

      await runtimeArtifacts.writeDiagnostic({
        sessionID: sessionId,
        scope: "background-compaction",
        severity: "info",
        message: "Executing background compaction for mark.",
        payload: { markId: eligible.markId },
      });

      try {
        const runInput = buildCompactionRunInputForMark({
          sessionId,
          state: projectionState.state,
          markId: eligible.markId,
          model: runtimeConfig.models[0],
          promptText: runtimeConfig.promptText,
          deletePromptText: runtimeConfig.deletePromptText,
          appliedResultGroupIds: new Set(projectionState.messages.flatMap(
            (message) => message.source === "result-group" && message.sourceMarkId ? [message.sourceMarkId] : [],
          )),
          timeoutMs: runtimeConfig.compressing.timeoutMs,
          firstTokenTimeoutMs: runtimeConfig.compressing.firstTokenTimeoutMs,
          streamIdleTimeoutMs: runtimeConfig.compressing.streamIdleTimeoutMs,
          compactionModels: runtimeConfig.models.slice(1),
          createdAt: eligible.createdAt,
        });
        const computation = await computeCompactionAttempt(
          {
            inputBuilder,
            transport: safeTransport,
            outputValidator,
            resultGroupRepository: resultGroupRepo,
            runtimeArtifacts,
          },
          runInput,
        );

        return {
          eligible,
          kind: "computed" as const,
          runInput,
          computation,
        };
      } catch (error) {
        const exhaustion = getCompactionModelChainExhaustionInfo(error);
        if (exhaustion !== null) {
          try {
            const failure = failureRepo.recordFailure({
              markId: eligible.markId,
              lastError: formatError(error),
              failedAt: new Date().toISOString(),
            });
            if (failure.failureCount >= maxFailureCount) {
              return {
                eligible,
                kind: "terminal" as const,
                failureCount: failure.failureCount,
                error,
              };
            }
            return {
              eligible,
              kind: "retryable" as const,
              failureCount: failure.failureCount,
              error,
            };
          } catch (persistenceError) {
            return {
              eligible,
              kind: "failed" as const,
              error: new Error(
                `Compaction exhausted the model chain, but failure count persistence failed: ${formatError(persistenceError)}`,
                { cause: persistenceError },
              ),
            };
          }
        }

        return {
          eligible,
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
          payload: { markId: item.eligible.markId },
        });
        continue;
      }

      if (
        item.kind === "terminal" ||
        item.kind === "retryable" ||
        item.kind === "failed"
      ) {
        didFail = true;
        firstFailureMessage ??= formatError(item.error);
        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "error",
          message: item.kind === "terminal"
            ? "Background compaction reached the cross-send failure limit for mark."
            : item.kind === "retryable"
              ? "Background compaction exhausted the model chain; the mark remains retryable."
              : "Background compaction failed before model-chain exhaustion.",
          payload: {
            markId: item.eligible.markId,
            ...(item.kind === "terminal" || item.kind === "retryable"
              ? { failureCount: item.failureCount, maxFailureCount }
              : {}),
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
            runtimeArtifacts,
          },
        );
        failureRepo.clear(item.eligible.markId);

        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "info",
          message: "Background compaction completed successfully.",
          payload: { markId: item.eligible.markId },
        });
      } catch (error) {
        didFail = true;
        firstFailureMessage ??= formatError(error);
        await runtimeArtifacts.writeDiagnostic({
          sessionID: sessionId,
          scope: "background-compaction",
          severity: "error",
          message: "Background compaction result commit failed.",
          payload: {
            markId: item.eligible.markId,
            error: formatError(error),
          },
        });
      }
    }

    await settleAndReleaseSessionFileLock({
      lockDirectory,
      sessionID: sessionId,
      status: didFail ? "failed" : "succeeded",
      note: didFail
        ? `background compaction completed with failure: ${firstFailureMessage ?? "unknown error"}`
        : `background compaction completed successfully (${eligibleMarks.length} marks processed)`,
    });

    if (didFail) {
      toastService?.showCompressionFailed(firstFailureMessage).catch(() => {});
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
