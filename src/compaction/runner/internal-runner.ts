import {
  CompactionTransportAbortedError,
  CompactionTransportFatalError,
  CompactionTransportMalformedPayloadError,
  CompactionTransportRetryableError,
  CompactionTransportTimeoutError,
} from "../transport/errors.js";
import { buildCompactionResultGroup } from "./result-group.js";
import type {
  InternalCompactionRunner,
  InternalCompactionRunnerDependencies,
} from "../runner.js";
import type {
  RunCompactionInput,
  RunCompactionResult,
} from "../types.js";
import { InvalidCompactionOutputError } from "../errors.js";
import type { ToastService } from "../../services/toast-service.js";
import { TokenCounter } from "../../utils/token-counter.js";

const DEFAULT_MAX_ATTEMPTS_PER_MODEL = 2;

export interface ContractLevelCompactionRunnerOptions {
  readonly now?: () => string;
  readonly toastService?: ToastService;
  readonly tokenCounter?: TokenCounter;
}

export function createContractLevelCompactionRunnerImplementation(
  dependencies: InternalCompactionRunnerDependencies,
  options: ContractLevelCompactionRunnerOptions = {},
): InternalCompactionRunner {
  const now = options.now ?? (() => new Date().toISOString());
  const toastService = options.toastService;
  const tokenCounter = options.tokenCounter ?? new TokenCounter();

  return {
    async run(input) {
      if (toastService) {
        toastService.showCompressionStarted().catch(() => {});
      }

      const modelChain = buildModelChain(input);
      const maxAttemptsPerModel = normalizeMaxAttemptsPerModel(
        input.maxAttemptsPerModel,
      );
      let lastRecoverableError: Error | undefined;

      for (const model of modelChain) {
        for (
          let attemptIndex = 0;
          attemptIndex < maxAttemptsPerModel;
          attemptIndex += 1
        ) {
          const request = await dependencies.inputBuilder.build({
            ...input.build,
            model,
          });

          try {
            const response = await dependencies.transport.execute(request);
            const validatedOutput = await dependencies.outputValidator.validate({
              request,
              response,
            });

            const resultGroup = buildCompactionResultGroup({
              request,
              validatedOutput,
              runInput: input,
              now,
            });

            await dependencies.resultGroupRepository.upsertCompleteGroup(resultGroup);

            if (toastService && tokenCounter) {
              try {
                const beforeTokens = request.transcript.reduce((sum: number, entry) => {
                  return sum + tokenCounter.countTokens(entry.contentText);
                }, 0);

                const afterTokens = resultGroup.fragments.reduce((sum: number, fragment) => {
                  return sum + tokenCounter.countTokens(fragment.replacementText);
                }, 0);

                const savedTokens = tokenCounter.calculateCompressionRatio(beforeTokens, afterTokens);
                toastService.showCompressionCompleted(savedTokens).catch(() => {});
              } catch {
                toastService.showCompressionCompleted().catch(() => {});
              }
            }

            return {
              request,
              response,
              validatedOutput,
            } satisfies RunCompactionResult;
          } catch (error) {
            if (isRecoverableCompactionFailure(error)) {
              lastRecoverableError = error;
              continue;
            }

            if (
              error instanceof CompactionTransportTimeoutError ||
              error instanceof CompactionTransportFatalError ||
              error instanceof CompactionTransportAbortedError
            ) {
              if (toastService) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                toastService.showCompressionFailed(errorMessage).catch(() => {});
              }
              throw error;
            }

            if (toastService) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              toastService.showCompressionFailed(errorMessage).catch(() => {});
            }
            throw error;
          }
        }
      }

      if (toastService) {
        const errorMessage = lastRecoverableError?.message ?? "All compaction models exhausted";
        toastService.showCompressionFailed(errorMessage).catch(() => {});
      }

      if (lastRecoverableError !== undefined) {
        throw lastRecoverableError;
      }

      throw new Error("Compaction runner exhausted its model chain without producing a result.");
    },
  } satisfies InternalCompactionRunner;
}

function buildModelChain(input: RunCompactionInput): readonly string[] {
  const seen = new Set<string>();
  const modelChain: string[] = [];

  for (const candidate of [input.build.model, ...(input.compactionModels ?? [])]) {
    const normalized = candidate.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    modelChain.push(normalized);
  }

  return Object.freeze(modelChain);
}

function normalizeMaxAttemptsPerModel(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_ATTEMPTS_PER_MODEL;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Compaction runner maxAttemptsPerModel must be a positive integer.");
  }

  return value;
}

function isRecoverableCompactionFailure(error: unknown): error is Error {
  return (
    error instanceof CompactionTransportRetryableError ||
    error instanceof CompactionTransportMalformedPayloadError ||
    error instanceof InvalidCompactionOutputError
  );
}
