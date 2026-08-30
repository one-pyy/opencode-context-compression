export {
  validateCompactionTransportPayload,
} from "./transport/validation.js";
export type { ValidatedCompactionTransportPayload } from "./transport/types.js";
import { defineInternalModuleContract } from "../internal/module-contract.js";
import { InvalidCompactionOutputError } from "./errors.js";
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
      const validated = validateCompactionTransportPayload(
        input.response.rawPayload,
        input.request,
      );

      const cleanValidated = {
        ...validated,
      };

      if (input.request.executionMode === "delete") {
        return cleanValidated;
      }

      return {
        ...cleanValidated,
        contentText: normalizeOpaqueOutput(cleanValidated.contentText, input.request),
      };
    },
  } satisfies OutputValidator;
}

function normalizeOpaqueOutput(
  contentText: string,
  request: CompactionValidationInput["request"],
): string {
  const opaquePattern = /<opaque\s+slot="([^"]+)"\s*\/>|<opaque\s+slot="([^"]+)"\s*>([\s\S]*?)<\/opaque>/gu;
  const expectedSlots = request.transcript
    .filter((entry) => entry.opaquePlaceholderSlot !== undefined)
    .map(
    (entry) => entry.opaquePlaceholderSlot!,
  );
  const actualSlots: string[] = [];
  let normalized = "";
  let cursor = 0;

  for (const match of contentText.matchAll(opaquePattern)) {
    const matchIndex = match.index!;
    const slot = match[1] ?? match[2]!;
    normalized += contentText.slice(cursor, matchIndex);
    normalized += `<opaque slot="${slot}"/>`;
    actualSlots.push(slot);
    cursor = matchIndex + match[0].length;
  }

  normalized += contentText.slice(cursor);
  const textWithoutValidPlaceholders = normalized.replace(
    /<opaque\s+slot="([^"]+)"\s*\/>/gu,
    "",
  );

  if (/<\/?opaque\b/iu.test(textWithoutValidPlaceholders)) {
    throw new InvalidCompactionOutputError({
      markId: request.markID,
      model: request.model,
      executionMode: request.executionMode,
      detail: "compact output must use numbered opaque placeholders.",
    });
  }

  const missingSlot = expectedSlots.find((slot) => !actualSlots.includes(slot));
  if (missingSlot !== undefined) {
    throw new InvalidCompactionOutputError({
      markId: request.markID,
      model: request.model,
      executionMode: request.executionMode,
      detail: `compact output must preserve opaque placeholder '${missingSlot}'.`,
    });
  }

  if (
    actualSlots.length !== expectedSlots.length ||
    actualSlots.some((slot, index) => slot !== expectedSlots[index])
  ) {
    throw new InvalidCompactionOutputError({
      markId: request.markID,
      model: request.model,
      executionMode: request.executionMode,
      detail: "compact output must preserve exactly the expected opaque placeholders in source order.",
    });
  }

  return normalized;
}
