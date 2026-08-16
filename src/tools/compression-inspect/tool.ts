import { randomBytes } from "node:crypto";

import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import {
  createCompressionInspectFailure,
  serializeCompressionInspectResult,
  toCompressionInspectToolInvocationContext,
  validateCompressionInspectInput,
  type CompressionInspectFailure,
  type CompressionInspectInputV1,
  type CompressionInspectResult,
  type CompressionInspectToolInvocationContext,
} from "./contract.js";

export interface CompressionInspectAdmissionInput {
  readonly sessionID: string;
  readonly to: string;
}

export type CompressionInspectAdmissionResult =
  | {
      readonly ok: true;
    }
  | CompressionInspectFailure;

export type CompressionInspectAdmission = (
  input: CompressionInspectAdmissionInput,
) => Promise<CompressionInspectAdmissionResult> | CompressionInspectAdmissionResult;

export interface CompressionInspectToolOptions {
  readonly admission?: CompressionInspectAdmission;
  readonly createInspectID?: (input: CompressionInspectAdmissionInput) => string;
}

export function createCompressionInspectAdmission(): CompressionInspectAdmission {
  return (input) => {
    if (input.sessionID.trim().length === 0) {
      return createCompressionInspectFailure(
        "SESSION_NOT_READY",
        "compression_inspect cannot be used yet because the session is not ready. This typically happens at the very start of a conversation before any messages exist.",
      );
    }

    return { ok: true };
  };
}

export function generateCompressionInspectID(): string {
  return `inspect_${randomBytes(6).toString("hex")}`;
}

export async function executeCompressionInspect(
  input: unknown,
  context: CompressionInspectToolInvocationContext,
  options: CompressionInspectToolOptions = {},
): Promise<CompressionInspectResult> {
  const parsed = validateCompressionInspectInput(input);
  if (!parsed.ok) {
    return parsed.result;
  }

  const admissionInput = {
    sessionID: context.sessionID,
    to: parsed.value.to,
  } satisfies CompressionInspectAdmissionInput;
  const admission = options.admission ?? createCompressionInspectAdmission();
  const decision = await admission(admissionInput);
  if (!decision.ok) {
    return decision;
  }

  const createInspectID = options.createInspectID ?? generateCompressionInspectID;
  return {
    ok: true,
    inspectId: createInspectID(admissionInput),
  };
}

export function createCompressionInspectTool(
  options: CompressionInspectToolOptions = {},
): ToolDefinition {
  return tool({
    description:
      "Inspect token counts for a visible message range before deciding whether to call compression_mark. " +
      "Use this when you need to choose an exact range for compression. Provide the to visible message ID — the range always starts from the first compressible message. " +
      "By default, the result groups visible content into sections split by referable replacements; protected messages split each section into contiguous compressible atoms. Sections and atoms contain token counts for semantic analysis and are not automatic mark recommendations. Set mergeAdjacent=false to receive per-message token counts. " +
      "After inspecting a range, either call compression_mark or leave the range unchanged. " +
      "Do not repeatedly inspect the same range unless new visible messages were added or the range boundaries changed. " +
      "compression_mark records a future compaction request; it does not immediately change the current visible context.",
    args: {
      to: tool.schema.string().min(1).describe(
        "The last visible message ID in the range to inspect (the range starts from the first compressible message)"
      ),
      mergeAdjacent: tool.schema.boolean().optional().default(true).describe(
        "Group messages into referable sections and protected-delimited compressible atoms; defaults to true"
      ),
    },
    async execute(args, context) {
      const result = await executeCompressionInspect(
        args satisfies CompressionInspectInputV1,
        toCompressionInspectToolInvocationContext(context),
        options,
      );
      return serializeCompressionInspectResult(result);
    },
  });
}
