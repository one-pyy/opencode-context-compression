export {
  validateCompactionTransportPayload,
} from "./transport/validation.js";
export type { ValidatedCompactionTransportPayload } from "./transport/types.js";
import { defineInternalModuleContract } from "../internal/module-contract.js";
import { InvalidCompactionOutputError } from "./errors.js";
import { includesOpaquePlaceholder } from "./opaque-placeholders.js";
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

      let contentText = validated.contentText;
      // Strip <analysis>...</analysis> blocks so they don't pollute the final projected history
      contentText = contentText.replace(/<analysis>[\s\S]*?<\/analysis>\n*/gi, '').trim();

      const cleanValidated = { ...validated, contentText };

      if (input.request.executionMode === "delete") {
        return cleanValidated;
      }

      let searchStart = 0;
      input.request.transcript.forEach((entry) => {
        if (entry.opaquePlaceholderSlot === undefined) {
          return;
        }

        const selfClosingTag = `<opaque slot="${entry.opaquePlaceholderSlot}"/>`;
        const selfClosingTagWithSpace = `<opaque slot="${entry.opaquePlaceholderSlot}" />`;
        const openTag = `<opaque slot="${entry.opaquePlaceholderSlot}">`;

        let placeholderIndex = cleanValidated.contentText.indexOf(selfClosingTag, searchStart);
        let matchLength = selfClosingTag.length;

        if (placeholderIndex < 0) {
          placeholderIndex = cleanValidated.contentText.indexOf(selfClosingTagWithSpace, searchStart);
          if (placeholderIndex >= 0) {
            matchLength = selfClosingTagWithSpace.length;
          }
        }

        if (placeholderIndex < 0) {
          placeholderIndex = cleanValidated.contentText.indexOf(openTag, searchStart);
          if (placeholderIndex >= 0) {
            const closeTag = "</opaque>";
            const closeIndex = cleanValidated.contentText.indexOf(closeTag, placeholderIndex + openTag.length);
            if (closeIndex >= 0) {
              matchLength = closeIndex + closeTag.length - placeholderIndex;
            } else {
              matchLength = openTag.length;
            }
          }
        }

        if (placeholderIndex < 0) {
          throw new InvalidCompactionOutputError({
            markId: input.request.markID,
            model: input.request.model,
            executionMode: input.request.executionMode,
            detail: `compact output must preserve opaque placeholder '${entry.opaquePlaceholderSlot}'.`,
          });
        }

        searchStart = placeholderIndex + matchLength;
      });

      return cleanValidated;
    },
  } satisfies OutputValidator;
}
