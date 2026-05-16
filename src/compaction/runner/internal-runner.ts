import { buildCompactionResultGroup } from "./result-group.js";
import type {
  InternalCompactionRunner,
  InternalCompactionRunnerDependencies,
} from "../runner.js";
import type {
  RunCompactionInput,
  RunCompactionResult,
} from "../types.js";
import type { ToastService } from "../../services/toast-service.js";
import { TokenCounter } from "../../utils/token-counter.js";

const DEFAULT_MAX_ATTEMPTS_PER_MODEL = 2;

export interface ContractLevelCompactionRunnerOptions {
  readonly now?: () => string;
  readonly toastService?: ToastService;
  readonly tokenCounter?: TokenCounter;
}

export interface CompactionAttemptComputation {
  readonly request: RunCompactionResult["request"];
  readonly response: RunCompactionResult["response"];
  readonly validatedOutput: RunCompactionResult["validatedOutput"];
}

export interface CompactionAttemptCommitInput {
  readonly computation: CompactionAttemptComputation;
  readonly runInput: RunCompactionInput;
}

export interface CompactionCommitOptions {
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

      let computation: CompactionAttemptComputation;
      try {
        computation = await computeCompactionAttempt(dependencies, input);
      } catch (error) {
        if (toastService) {
          toastService.showCompressionFailed(formatErrorMessage(error)).catch(() => {});
        }
        throw error;
      }

      await commitCompactionAttempt({ computation, runInput: input }, dependencies, {
        now,
        toastService,
        tokenCounter,
      });

      return computation;
    },
  } satisfies InternalCompactionRunner;
}

export async function computeCompactionAttempt(
  dependencies: InternalCompactionRunnerDependencies,
  input: RunCompactionInput,
): Promise<CompactionAttemptComputation> {
  const modelChain = buildModelChain(input);
  const maxAttemptsPerModel = normalizeMaxAttemptsPerModel(
    input.maxAttemptsPerModel,
  );
  let lastAttemptError: unknown;

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

        return {
          request,
          response,
          validatedOutput,
        } satisfies CompactionAttemptComputation;
      } catch (error) {
        lastAttemptError = error;
        continue;
      }
    }
  }

  if (lastAttemptError !== undefined) {
    throw lastAttemptError;
  }

  throw new Error("Compaction runner exhausted its model chain without producing a result.");
}

export async function commitCompactionAttempt(
  input: CompactionAttemptCommitInput,
  dependencies: InternalCompactionRunnerDependencies,
  options: CompactionCommitOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date().toISOString());
  const toastService = options.toastService;
  const tokenCounter = options.tokenCounter ?? new TokenCounter();
  const resultGroup = buildCompactionResultGroup({
    request: input.computation.request,
    validatedOutput: input.computation.validatedOutput,
    runInput: input.runInput,
    now,
  });

  await dependencies.resultGroupRepository.upsertCompleteGroup(resultGroup);

  if (toastService && tokenCounter) {
    try {
      const beforeTokens = input.computation.request.transcript.reduce((sum: number, entry) => {
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

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
