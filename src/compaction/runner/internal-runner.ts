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

const DEFAULT_MAX_ATTEMPTS_PER_MODEL = 2;

export interface ContractLevelCompactionRunnerOptions {
  readonly now?: () => string;
}

export function createContractLevelCompactionRunnerImplementation(
  dependencies: InternalCompactionRunnerDependencies,
  options: ContractLevelCompactionRunnerOptions = {},
): InternalCompactionRunner {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async run(input) {
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

            await dependencies.resultGroupRepository.upsertCompleteGroup(
              buildCompactionResultGroup({
                request,
                validatedOutput,
                runInput: input,
                now,
              }),
            );

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
              throw error;
            }

            throw error;
          }
        }
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
