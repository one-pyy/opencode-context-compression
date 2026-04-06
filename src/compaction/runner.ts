export {
  createCompactionRunner,
  executeCompactionAttempt,
  type CompactionRunner,
  type CompactionRunnerDependencies,
} from "./runner/compaction-runner.js";
import { defineInternalModuleContract } from "../internal/module-contract.js";
import type { SafeTransportAdapter } from "../runtime/compaction-transport.js";
import type { ResultGroupRepository } from "../state/result-group-repository.js";
import type { CompactionInputBuilder } from "./input-builder.js";
import type { OutputValidator } from "./output-validation.js";
import { createContractLevelCompactionRunnerImplementation } from "./runner/internal-runner.js";
import type {
  RunCompactionInput,
  RunCompactionResult,
} from "./types.js";

export interface InternalCompactionRunner {
  run(input: RunCompactionInput): Promise<RunCompactionResult>;
}

export interface InternalCompactionRunnerDependencies {
  readonly inputBuilder: CompactionInputBuilder;
  readonly transport: SafeTransportAdapter;
  readonly outputValidator: OutputValidator;
  readonly resultGroupRepository: ResultGroupRepository;
}

export interface ContractLevelCompactionRunnerOptions {
  readonly now?: () => string;
}

export const COMPACTION_RUNNER_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "CompactionRunner",
    inputs: ["RunCompactionInput"],
    outputs: ["RunCompactionResult"],
    mutability: "mutable",
    reads: [
      "compaction build input",
      "safe transport response",
      "result-group repository read/write surface",
    ],
    writes: ["committed result groups after validation in later tasks"],
    errorTypes: [
      "TRANSPORT_TIMEOUT",
      "INVALID_COMPACTION_OUTPUT",
      "RESULT_GROUP_INCOMPLETE",
    ],
    idempotency:
      "Not globally idempotent; repeated runs may repeat transport work, while repository persistence remains delegated to later task logic.",
    dependencyDirection: {
      inboundFrom: ["external-adapters"],
      outboundTo: [
        "CompactionInputBuilder",
        "SafeTransportAdapter",
        "OutputValidator",
        "ResultGroupRepository",
      ],
    },
  });

export function createContractLevelCompactionRunner(
  dependencies: InternalCompactionRunnerDependencies,
  options: ContractLevelCompactionRunnerOptions = {},
): InternalCompactionRunner {
  return createContractLevelCompactionRunnerImplementation(
    dependencies,
    options,
  );
}

export type { RunCompactionInput, RunCompactionResult } from "./types.js";
