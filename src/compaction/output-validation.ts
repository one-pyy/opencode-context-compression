export {
  validateCompactionTransportPayload,
} from "./transport/validation.js";
export type { ValidatedCompactionTransportPayload } from "./transport/types.js";
import { defineInternalModuleContract } from "../internal/module-contract.js";
import { validateCompactionTransportPayload } from "./transport/validation.js";
import type {
  CompactionValidationInput,
  ValidatedCompactionOutput,
} from "./types.js";

export interface OutputValidator {
  validate(
    input: CompactionValidationInput,
  ): Promise<ValidatedCompactionOutput>;
}

export const OUTPUT_VALIDATOR_INTERNAL_CONTRACT = defineInternalModuleContract({
  module: "OutputValidator",
  inputs: ["CompactionValidationInput"],
  outputs: ["ValidatedCompactionOutput"],
  mutability: "read-only",
  reads: ["safe transport raw payload", "request execution mode and mark identity"],
  writes: [],
  errorTypes: ["INVALID_COMPACTION_OUTPUT"],
  idempotency:
    "Deterministic for the same transport response and originating request.",
  dependencyDirection: {
    inboundFrom: ["CompactionRunner"],
    outboundTo: [],
  },
});

export function createOutputValidator(): OutputValidator {
  return {
    async validate(input) {
      return validateCompactionTransportPayload(
        input.response.rawPayload,
        input.request,
      );
    },
  } satisfies OutputValidator;
}
