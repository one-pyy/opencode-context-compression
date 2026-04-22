import { randomBytes } from "node:crypto";

import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import {
  createCompressionMarkFailure,
  serializeCompressionMarkResult,
  toCompressionMarkToolInvocationContext,
  type CompressionMarkFailure,
  type CompressionMarkInputV1,
  type CompressionMarkMode,
  type CompressionMarkResult,
  type CompressionMarkToolInvocationContext,
  validateCompressionMarkInput,
} from "./contract.js";

export interface CompressionMarkAdmissionInput {
  readonly sessionID: string;
  readonly mode: CompressionMarkMode;
  readonly from: string;
  readonly to: string;
  readonly hint?: string;
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
        "compression_mark cannot be used yet because the session is not ready. This typically happens at the very start of a conversation before any messages exist.",
      );
    }

    if (input.mode === "delete" && !options.allowDelete) {
      return createCompressionMarkFailure(
        "DELETE_NOT_ALLOWED",
        'compression_mark mode="delete" is not allowed in this session. Use mode="compact" instead to compress messages into summaries while preserving important information.',
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
    from: parsed.value.from,
    to: parsed.value.to,
    hint: parsed.value.hint,
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
      "Mark a range of conversation messages for compression or deletion. This reduces context size while preserving important information.\n\n" +
      "## When to use:\n" +
      "- **compact**: Compress verbose conversations into dense summaries (recommended for most cases)\n" +
      "- **delete**: Completely remove messages (use only for truly irrelevant content)\n\n" +
      "## How to identify message IDs:\n" +
      "Look for visible message IDs in the conversation history. They use the format `<visible-type>_<seq6>_<check_sum>`, where `<visible-type>` must be one of `protected`, `compressible`, or `referable`, and `<check_sum>` is a 2-character checksum suffix. Examples: `protected_000001_q7`, `compressible_000002_m2`, `referable_000003_w1`.\n" +
      "Example: To compress messages from compressible_000123_ab to referable_000130_q7, use those as start/end IDs.\n\n" +
      "## Marking multiple segments:\n" +
      "A single tool call marks one continuous range. If one reply needs to mark multiple separate segments, call this tool multiple times in the same reply.\n\n" +
      "## Protected messages:\n" +
      "Protected messages are preserved automatically and do not need special handling. You may still include them inside a marked range; the runtime will protect them as needed.\n\n" +
      "## Hint (optional):\n" +
      "Guide the compression strategy with a brief instruction:\n" +
      "- 'Preserve all file paths and error messages from this debugging session'\n" +
      "- 'Focus on the final solution, compress intermediate exploration steps'\n" +
      "- 'Keep tool parameters and results, summarize conversational parts'\n" +
      "- 'This is context gathering, retain all discovered file locations'\n\n" +
      "## Example usage:\n" +
      "```json\n" +
      "{\n" +
      '  "mode": "compact",\n' +
      '  "from": "compressible_000123_ab",\n' +
      '  "to": "referable_000130_q7",\n' +
      '  "hint": "Preserve file paths and error messages"\n' +
      "}\n" +
      "```\n\n" +
      "## What happens after:\n" +
      "- Returns a markId for tracking\n" +
      "- Compression happens asynchronously in the background\n" +
      "- Compressed content replaces the original range in future context\n" +
      "- You can continue working immediately; compression doesn't block your workflow",
    args: {
      mode: tool.schema.enum(["compact", "delete"]).describe(
        'Use "compact" to compress messages into summaries, or "delete" to remove them entirely'
      ),
      from: tool.schema.string().min(1).describe(
        "The visible message ID where the range starts (format: <visible-type>_<seq6>_<check_sum>, with a 2-character checksum suffix)"
      ),
      to: tool.schema.string().min(1).describe(
        "The visible message ID where the range ends (format: <visible-type>_<seq6>_<check_sum>, with a 2-character checksum suffix)"
      ),
      hint: tool.schema.string().optional().describe(
        "Optional guidance for the compression strategy (e.g., 'Preserve all file paths')"
      ),
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
