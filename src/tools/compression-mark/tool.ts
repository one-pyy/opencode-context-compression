import { randomBytes } from "node:crypto";

import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import {
  COMPRESSION_MARK_CONTRACT_VERSION,
  createCompressionMarkFailure,
  serializeCompressionMarkResult,
  toCompressionMarkToolInvocationContext,
  type CompressionMarkFailure,
  type CompressionMarkInputV1,
  type CompressionMarkMode,
  type CompressionMarkResult,
  type CompressionMarkTarget,
  type CompressionMarkToolInvocationContext,
  validateCompressionMarkInput,
} from "./contract.js";

export interface CompressionMarkAdmissionInput {
  readonly sessionID: string;
  readonly mode: CompressionMarkMode;
  readonly target: CompressionMarkTarget;
}

export type CompressionMarkAdmissionResult =
  | {
      readonly ok: true;
    }
  | CompressionMarkFailure;

export type CompressionMarkAdmission = (
  input: CompressionMarkAdmissionInput,
) => Promise<CompressionMarkAdmissionResult> | CompressionMarkAdmissionResult;

export interface CompressionMarkToolOptions {
  readonly admission?: CompressionMarkAdmission;
  readonly createMarkID?: (input: CompressionMarkAdmissionInput) => string;
}

export function createCompressionMarkAdmission(options: {
  readonly allowDelete: boolean;
}): CompressionMarkAdmission {
  return (input) => {
    if (input.sessionID.trim().length === 0) {
      return createCompressionMarkFailure(
        "SESSION_NOT_READY",
        "compression_mark requires a non-empty sessionID before replay and scheduling can reason about the request.",
      );
    }

    if (input.mode === "delete" && !options.allowDelete) {
      return createCompressionMarkFailure(
        "DELETE_NOT_ALLOWED",
        "compression_mark mode='delete' is blocked by the current delete-admission policy.",
      );
    }

    return { ok: true };
  };
}

export function generateCompressionMarkID(): string {
  return `mark_${randomBytes(6).toString("hex")}`;
}

export async function executeCompressionMark(
  input: unknown,
  context: CompressionMarkToolInvocationContext,
  options: CompressionMarkToolOptions = {},
): Promise<CompressionMarkResult> {
  const parsed = validateCompressionMarkInput(input);
  if (!parsed.ok) {
    return parsed.result;
  }

  const admissionInput = {
    sessionID: context.sessionID,
    mode: parsed.value.mode,
    target: parsed.value.target,
  } satisfies CompressionMarkAdmissionInput;
  const admission =
    options.admission ?? createCompressionMarkAdmission({ allowDelete: false });
  const decision = await admission(admissionInput);
  if (!decision.ok) {
    return decision;
  }

  const createMarkID = options.createMarkID ?? generateCompressionMarkID;
  return {
    ok: true,
    markId: createMarkID(admissionInput),
  };
}

export function createCompressionMarkTool(
  options: CompressionMarkToolOptions = {},
): ToolDefinition {
  return tool({
    description:
      "Record one replayable compression or delete mark for a visible message range. Optionally provide a hint to guide compression strategy.\n\n" +
      "Hint examples:\n" +
      "- 'Preserve all file paths and error messages from this debugging session'\n" +
      "- 'Focus on the final solution, compress intermediate exploration steps'\n" +
      "- 'Keep tool parameters and results, summarize conversational parts'\n" +
      "- 'This is context gathering, retain all discovered file locations'",
    args: {
      contractVersion: tool.schema.literal(COMPRESSION_MARK_CONTRACT_VERSION),
      mode: tool.schema.enum(["compact", "delete"]),
      target: tool.schema.object({
        startVisibleMessageID: tool.schema.string().min(1),
        endVisibleMessageID: tool.schema.string().min(1),
        hint: tool.schema.string().optional(),
      }),
    },
    async execute(args, context) {
      const result = await executeCompressionMark(
        args satisfies CompressionMarkInputV1,
        toCompressionMarkToolInvocationContext(context),
        options,
      );
      return serializeCompressionMarkResult(result);
    },
  });
}
