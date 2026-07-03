import { randomBytes } from "node:crypto";

import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import {
  createCompressionRecallFailure,
  serializeCompressionRecallResult,
  toCompressionRecallToolInvocationContext,
  validateCompressionRecallInput,
  type CompressionRecallFailure,
  type CompressionRecallInputV1,
  type CompressionRecallResult,
  type CompressionRecallToolInvocationContext,
} from "./contract.js";

export interface CompressionRecallAdmissionInput {
  readonly sessionID: string;
  readonly from: string;
  readonly to: string;
}

export type CompressionRecallAdmissionResult =
  | {
      readonly ok: true;
    }
  | CompressionRecallFailure;

export type CompressionRecallAdmission = (
  input: CompressionRecallAdmissionInput,
) =>
  | Promise<CompressionRecallAdmissionResult>
  | CompressionRecallAdmissionResult;

export interface CompressionRecallToolOptions {
  readonly admission?: CompressionRecallAdmission;
  readonly createRecallID?: (input: CompressionRecallAdmissionInput) => string;
}

export function createCompressionRecallAdmission(): CompressionRecallAdmission {
  return (input) => {
    if (input.sessionID.trim().length === 0) {
      return createCompressionRecallFailure(
        "SESSION_NOT_READY",
        "compression_recall cannot be used yet because the session is not ready. This typically happens at the very start of a conversation before any messages exist.",
      );
    }

    return { ok: true };
  };
}

export function generateCompressionRecallID(): string {
  return `recall_${randomBytes(6).toString("hex")}`;
}

export async function executeCompressionRecall(
  input: unknown,
  context: CompressionRecallToolInvocationContext,
  options: CompressionRecallToolOptions = {},
): Promise<CompressionRecallResult> {
  const parsed = validateCompressionRecallInput(input);
  if (!parsed.ok) {
    return parsed.result;
  }

  const admissionInput = {
    sessionID: context.sessionID,
    from: parsed.value.from,
    to: parsed.value.to,
  } satisfies CompressionRecallAdmissionInput;
  const admission =
    options.admission ?? createCompressionRecallAdmission();
  const decision = await admission(admissionInput);
  if (!decision.ok) {
    return decision;
  }

  const createRecallID = options.createRecallID ?? generateCompressionRecallID;
  return {
    ok: true,
    recallId: createRecallID(admissionInput),
  };
}

export function createCompressionRecallTool(
  options: CompressionRecallToolOptions = {},
): ToolDefinition {
  return tool({
    description:
      "Recall the original host history content behind a visible message range.\n\n" +
      "## When to use:\n" +
      "- You see a [referable_xxx~yyy] compressed summary and need the original details it was compressed from\n" +
      "- You need to verify what was actually said before compression\n" +
      "- You need to quote or reference specific content that was summarized away\n\n" +
      "## What you get:\n" +
      "- Original messages from host history in that sequence range, rendered as transcript blocks\n" +
      "- For compressed ranges, this is the pre-compression content\n" +
      "- For uncompressed ranges, this is the raw content without projection formatting\n\n" +
      "## Input:\n" +
      "- `from` and `to` are inclusive visible message ID endpoints (same format as compression_mark)\n" +
      "- Any visible ID type works (compressible, referable, protected); only the sequence number is used\n" +
      "- The range covers all host history messages between the two sequence numbers\n\n" +
      "## Important:\n" +
      "- The recalled content stays in context and consumes tokens\n" +
      "- Extract key information into your reply rather than relying on persistent access\n" +
      "- When done, you can compression_mark the recall result to compress it again\n" +
      "- You can recall any visible range, not just compressed summaries\n\n" +
      "## Example:\n" +
      '```json\n' +
      '{\n' +
      '  "from": "referable_000123_ab",\n' +
      '  "to": "referable_000130_q7"\n' +
      "}\n" +
      "```\n\n" +
      "## What happens after:\n" +
      "- Returns a recallId for tracking\n" +
      "- The original transcript is filled in by the next projection cycle\n" +
      "- The recall result is a normal message that can be compressed like any other",
    args: {
      from: tool.schema.string().min(1).describe(
        "The visible message ID where the inclusive recall range starts (any type: compressible, referable, protected)"
      ),
      to: tool.schema.string().min(1).describe(
        "The visible message ID where the inclusive recall range ends (any type: compressible, referable, protected)"
      ),
    },
    async execute(args, context) {
      const result = await executeCompressionRecall(
        args satisfies CompressionRecallInputV1,
        toCompressionRecallToolInvocationContext(context),
        options,
      );
      return serializeCompressionRecallResult(result);
    },
  });
}
