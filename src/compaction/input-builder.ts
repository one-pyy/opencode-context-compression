export {
  buildCompactionTransportRequest,
  type BuildCompactionTransportRequestInput,
  type BuildCompactionTransportTranscriptEntryInput,
} from "./transport/request.js";
import { defineInternalModuleContract } from "../internal/module-contract.js";
import { renderOpaquePlaceholder } from "./opaque-placeholders.js";
import { buildCompactionTransportRequest } from "./transport/request.js";
import type {
  CompactionBuildInput,
  CompactionRequest,
} from "./types.js";

export interface CompactionInputBuilder {
  build(input: CompactionBuildInput): Promise<CompactionRequest>;
}

export const COMPACTION_INPUT_BUILDER_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "CompactionInputBuilder",
    inputs: ["CompactionBuildInput"],
    outputs: ["CompactionRequest"],
    mutability: "read-only",
    reads: ["prompt text", "frozen transcript slice", "runtime timeout input"],
    writes: [],
    errorTypes: ["CompactionTransportConfigurationError"],
    idempotency:
      "Deterministic for the same build input, transcript ordering, and timeout.",
    dependencyDirection: {
      inboundFrom: ["CompactionRunner"],
      outboundTo: [],
    },
  });

export function createCompactionInputBuilder(): CompactionInputBuilder {
  return {
    async build(input) {
      return buildCompactionTransportRequest({
        sessionID: input.sessionId,
        markID: input.markId,
        model: input.model,
        executionMode: input.executionMode,
        promptText: input.promptText,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        transcript: input.transcript.map((entry) => ({
          role: entry.role,
          hostMessageID: entry.hostMessageId,
          sourceStartSeq: entry.sourceStartSeq,
          sourceEndSeq: entry.sourceEndSeq,
          opaquePlaceholderSlot: entry.opaquePlaceholder?.slot,
          contentText:
            entry.opaquePlaceholder === undefined
              ? entry.contentText
              : renderOpaquePlaceholder(
                  entry.opaquePlaceholder.slot,
                  entry.contentText,
                ),
        })),
      });
    },
  } satisfies CompactionInputBuilder;
}
