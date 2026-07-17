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
import type { CompactionRequest } from "../types.js";
import { markCompactionModelChainExhausted } from "../errors.js";
import { CompactionTransportEmptyResponseError } from "../transport/errors.js";
import type { CompleteResultGroupInput } from "../../state/result-group-repository.js";

export interface ContractLevelCompactionRunnerOptions {
  readonly now?: () => string;
  readonly toastService?: ToastService;
  readonly tokenCounter?: TokenCounter;
}

export interface CompactionComputeOptions {
  readonly now?: () => string;
}

export interface CompactionAttemptComputation {
  readonly request: RunCompactionResult["request"];
  readonly response: RunCompactionResult["response"];
  readonly validatedOutput: RunCompactionResult["validatedOutput"];
  readonly resultGroup: CompleteResultGroupInput;
  readonly attemptIndex: number;
}

export interface CompactionAttemptCommitInput {
  readonly computation: CompactionAttemptComputation;
  readonly runInput: RunCompactionInput;
}

export interface CompactionCommitOptions {
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
        computation = await computeCompactionAttempt(dependencies, input, { now });
      } catch (error) {
        if (toastService) {
          toastService.showCompressionFailed(formatErrorMessage(error)).catch(() => {});
        }
        throw error;
      }

      await commitCompactionAttempt({ computation, runInput: input }, dependencies, {
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
  options: CompactionComputeOptions = {},
): Promise<CompactionAttemptComputation> {
  const now = options.now ?? (() => new Date().toISOString());
  const modelChain = buildModelChain(input);
  let lastAttemptError: unknown;

  for (let modelIndex = 0; modelIndex < modelChain.length; modelIndex += 1) {
    const model = modelChain[modelIndex]!;
    const attemptIndex = modelIndex;
    const request = await dependencies.inputBuilder.build({
      ...input.build,
      model,
    });
    const recordCreatedAt = new Date().toISOString();

    try {
      await writeCompactionRecordSafely(dependencies, input, request, {
        createdAt: recordCreatedAt,
        suffix: "in",
        payload: request,
        attemptIndex,
      });
      const response = await dependencies.transport.execute(request);
      await writeCompactionRecordSafely(dependencies, input, request, {
        createdAt: recordCreatedAt,
        suffix: "out",
        payload: response.rawPayload,
        attemptIndex,
      });
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

      return {
        request,
        response,
        validatedOutput,
        resultGroup,
        attemptIndex,
      } satisfies CompactionAttemptComputation;
    } catch (error) {
      await writeCompactionRecordSafely(dependencies, input, request, {
        createdAt: recordCreatedAt,
        suffix: "err",
        payload: buildCompactionErrorRecord(error),
        attemptIndex,
      });
      lastAttemptError = error;
      continue;
    }
  }

  throw markCompactionModelChainExhausted(
    lastAttemptError ?? new Error("Compaction runner exhausted its model chain without producing a result."),
    {
      attempts: modelChain.length,
    },
  );
}

export async function commitCompactionAttempt(
  input: CompactionAttemptCommitInput,
  dependencies: InternalCompactionRunnerDependencies,
  options: CompactionCommitOptions = {},
): Promise<void> {
  const toastService = options.toastService;
  const tokenCounter = options.tokenCounter ?? new TokenCounter();
  const resultGroup = input.computation.resultGroup;

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

async function writeCompactionRecordSafely(
  dependencies: InternalCompactionRunnerDependencies,
  input: RunCompactionInput,
  request: CompactionRequest,
  record: {
    readonly createdAt: string;
    readonly suffix: "in" | "out" | "err";
    readonly payload: unknown;
    readonly attemptIndex: number;
  },
): Promise<void> {
  const runtimeArtifacts = dependencies.runtimeArtifacts;
  if (runtimeArtifacts === undefined) {
    return;
  }

  try {
    await runtimeArtifacts.writeCompactionRecord({
      sessionID: request.sessionID,
      sourceStartSeq: input.resultGroup?.sourceStartSeq,
      sourceEndSeq: input.resultGroup?.sourceEndSeq,
      createdAt: record.createdAt,
      suffix: record.suffix,
      payload: record.payload,
      model: request.model,
      attemptIndex: record.attemptIndex,
    });
  } catch (error) {
    await runtimeArtifacts.writeDiagnostic({
      sessionID: request.sessionID,
      scope: "compaction-records",
      severity: "error",
      message: "Failed to write compaction model exchange record.",
      payload: {
        markId: request.markID,
        suffix: record.suffix,
        error: formatErrorMessage(error),
      },
    });
  }
}

function buildCompactionErrorRecord(error: unknown): unknown {
  if (error instanceof CompactionTransportEmptyResponseError) {
    return {
      name: error.name,
      message: error.message,
      diagnostic: error.diagnosticPayload,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "NonErrorThrown",
    message: String(error),
  };
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

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
