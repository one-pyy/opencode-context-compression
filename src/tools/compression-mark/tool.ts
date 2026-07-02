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
      "## Important boundary:\n" +
      "After `compression_mark` succeeds, the original details in the marked range may disappear from future visible context at any time. Mark only content whose details are no longer needed, or whose details have already been externalized into reliable files with enough fidelity to continue the task.\n" +
      "Core test: if future work still needs many details from this range, do not mark it.\n\n" +
      "## Prioritize marking:\n" +
      "Completion, verification, a commit, or user approval only means the result is stable; it does not mean the details are safe to lose. Prioritize these candidates only after the details needed for future work have been externalized or are no longer needed.\n" +
      "- Content the user explicitly asks to compress, or refers to with `cpmark`.\n" +
      "- Completed and verified code changes, bug fixes, configuration changes, or documentation writes, after the final result, verification evidence, and any reusable rationale have been reported or written to a durable place.\n" +
      "- Requirements the user has confirmed as complete, only when the accepted result no longer needs the preceding discussion details and the user has moved to an unrelated new request.\n" +
      "- Externalized and verified intermediate materials such as search results, analysis notes, report drafts, or implementation notes, when future work only needs the path and conclusion.\n" +
      "- Verbose tool output, repeated logs, and failed attempts, when the final conclusion, error cause, effective fix, or current state has been preserved and line-by-line detail is no longer needed.\n" +
      "- Exploration superseded by a final approach, when rejection reasons or key tradeoffs have been preserved.\n" +
      "- Completed subagent investigations, audits, batch searches, or long log analyses, when conclusions, file paths, and unresolved risks are enough.\n\n" +
      "## Do not mark:\n" +
      "- Context for the task currently in progress.\n" +
      "- Interviews, requirement clarification, user preferences, design discussions, acceptance criteria, or draft content that has not been externalized.\n" +
      "- Interview or design details that are externalized but still under user review, feedback, or direction changes.\n" +
      "- Errors, failing tests, debugging process, open assumptions, or option comparisons that are still unresolved and whose details are still needed for later judgment.\n" +
      "- Recent context needed to judge wording, boundaries, user intent, corrections, counterexamples, or acceptance criteria.\n\n" +
      "## If hard context pressure exists but all visible candidates are risky:\n" +
      "Do not force a compression_mark call. Use the `question` tool to ask the user about each candidate process.\n" +
      "Question format: `Should I compress {process name}?` Description: briefly explain what the process contains, what direct compression may lose, and what would be preserved before compression. Options: `Directly compress`, `Write to file then compress`, `Explain in detail`; leave custom input available.\n" +
      "If the user chooses `Write to file then compress`, first write a continuation file under `.sisyphus/tmp/compression/` with enough detail to resume: user constraints, unfinished work, target files, confirmed design, key original wording, irrecoverable details, and next step. Writing this file does not mean the task is complete; after marking, return to the original task immediately.\n\n" +
      "## How to identify message IDs:\n" +
      "Look for visible message IDs in the conversation history. They use the format `<visible-type>_<seq6>_<check_sum>`, where `<visible-type>` must be one of `protected`, `compressible`, or `referable`, and `<check_sum>` is a 2-character checksum suffix. Examples: `protected_000001_q7`, `compressible_000002_m2`, `referable_000003_w1`.\n" +
      "The range is inclusive: both from and to messages are included. Example: To compress messages from compressible_000123_ab to referable_000130_q7, use those as start/end IDs. If from and to are the same ID, that single visible message is targeted.\n\n" +
      "## Marking multiple segments:\n" +
      "A single tool call marks one continuous range. If one reply needs to mark multiple separate segments, call this tool multiple times in the same reply.\n\n" +
      "## Protected messages:\n" +
      "Protected messages are preserved automatically and do not need special handling. You may still include them inside a marked range; the runtime will protect them as needed.\n\n" +
      "## Hint (optional):\n" +
      "Guide the compression strategy by signaling task completion status and what must be preserved.\n\n" +
      "**Three types of hints:**\n" +
      "1. **Task completion / externalization** — Tell the compressor this work is done only when the needed conclusion, evidence, and reusable rationale are already externalized or no longer needed in detail:\n" +
      "   - 'Task completed and final conclusion externalized. Bug fixed; root cause, fix, verification, and reusable rationale are already written or reported. Compress implementation chatter to those durable facts.'\n" +
      "   - 'Search results externalized to .sisyphus/tmp/work/search-2026-w19.md — keep path and purpose, drop dump bodies.'\n" +
      "2. **Must-preserve items** — Name specific entities, decisions, or constraints that must survive:\n" +
      "   - 'Preserve candidate names: Mini Shai-Hulud, NuGet malicious packages, Antel TuID, FastSim.'\n" +
      "   - 'Keep de-prioritization rationale for each rejected option.'\n" +
      "3. **Drop authorization** — Explicitly allow compression of verbose content:\n" +
      "   - 'Do not preserve each search result verbatim.'\n" +
      "   - 'Compress intermediate exploration steps.'\n\n" +
      "The compressor treats named entities in hints as highest priority and will preserve them even if they would otherwise be summarized.\n\n" +
      "## Example usage:\n" +
      "```json\n" +
      "{\n" +
      '  "mode": "compact",\n' +
      '  "from": "compressible_000123_ab",\n' +
      '  "to": "referable_000130_q7",\n' +
      '  "hint": "Task completed and final conclusion externalized. Compress exploration to file paths. Preserve final solution, verification evidence, reusable rationale, and user-stated constraints."\n' +
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
        "Optional guidance: signal task completion ('Task done, compress to links'), name must-preserve items ('Keep candidates X, Y, Z'), or authorize drops ('Compress exploration verbatim'). Named entities are always preserved."
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
