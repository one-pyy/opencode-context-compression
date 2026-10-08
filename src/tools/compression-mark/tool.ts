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
      "- **delete**: 整理当前有效信息并退役旧过程。后台模型合并已有摘要与未压缩原文，用仍有效的要求、约束、决定、结论、证据限制和未决事项替换旧内容；有有效信息需要继承时仍可选择该范围，前提是所需信息已留存并核对，旧过程细节已不再需要。此前未加载 `context-retire` 时先加载，已完整加载则复用。普通 reminder 或 cpmark 对未压缩原文使用 compact；退役提醒以已应用 compact 摘要为候选，可包含中间符合条件的原文。自主处理符合条件的范围；仍需依赖原文判断或无法核对的内容保留。\n\n" +
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
      "Retain the risky ranges and continue the task. Where useful details can be preserved in files, first write and verify a continuation file under `.sisyphus/tmp/compression/` with enough detail to resume: user constraints, unfinished work, target files, confirmed design, key original wording, irrecoverable details, and next step. Mark only after the range meets the preservation criteria. Writing this file does not mean the task is complete; after marking, return to the original task immediately.\n\n" +
      "## How to identify message IDs:\n" +
      "Look for visible message IDs in the conversation history. They use the format `<visible-type>_<seq6>_<check_sum>`, where `<check_sum>` is a 2-character checksum suffix. The `<visible-type>_` segment is display-only and may be omitted: a bare `<seq6>_<check_sum>` id such as `000002_m2` resolves to the same host message. Mark endpoints may be host message IDs (`protected` or `compressible`) or the `referable_...~referable_...` range markers you currently see for applied compression results; a referable marker must match a current result and resolves to the source messages it covers. Examples: `protected_000001_q7`, `compressible_000002_m2`, `referable_000015_ab`.\n" +
      "The range is inclusive: both from and to messages are included. Example: To compress messages from compressible_000123_ab to compressible_000130_q7, use those as start/end IDs. If from and to are the same ID, that single visible message is targeted.\n\n" +
      "## Marking multiple segments:\n" +
      "建议跨 `compression_inspect` 的 atom、section 和 delete 条目选取连续范围，按任务或主题判断内容，减少工具调用往返。这些分段只用于统计，不决定 mark 边界；可以跨 protected 用户消息，compact 会保留其原文。用 hint 指定整个范围必须保留的关键内容。活跃细节、区间冲突或模型输入预算需要时才拆段；第一轮批量标记所有符合条件的范围。若有标记被拒绝，按拒绝原因重新核验未处理内容与合法边界，可进行第二轮补标，最多两轮；第二轮不得重复已接受标记或盲目扩大冲突选区。\n" +
      "成功但尚未应用的标记视为已处理，避免重复覆盖；已应用 compact 可完整纳入更大范围，compact 保持已有摘要，delete 可进一步提炼。部分交叉会被拒绝。delete 必须完整覆盖涉及的已有 compact 标记及摘要片段，不能严格落在已有 mark 内部；选区避开已有 delete。\n\n" +
      "## Protected messages:\n" +
      "Compact preserves protected originals. Delete may remove user originals, including short messages, so first verify that their still-valid meaning and scope will survive in the result or in checked, discoverable local materials. System messages remain protected.\n\n" +
      "## Delete range and preparation:\n" +
      "Delete can consume complete applied compact summaries plus uncovered originals. Include each summary fragment in full. A summary fragment shows up in context as a `[referable_...~referable_...]` range: pass those two markers as the range endpoints to consume it (a `compression_inspect` call with `mode=delete` lists each fragment's marker pair as its `from` and `to`), or use host visible IDs that bracket the whole fragment (the nearest visible messages before and after it). Either way the fragment must be covered completely. Write and verify still-valid requirements, preferences, conclusions, evidence boundaries and unresolved work in discoverable project-local files before marking; include file paths and essential current facts in hint. Once delete takes effect, compression_recall cannot retrieve its source range. Age or completion alone does not justify deletion. If the assembled input is too large, split it into independent legal ranges; a failed attempt leaves existing content available.\n\n" +
      "## Hint (optional):\n" +
      "通过 hint 明确指定跨段范围必须保留的关键事实、精确参数、用户约束、决定、证据限制、未决事项及完整资料路径。说明已核对文件的用途，以及哪些过程可以简化。关键保留项必须进入最终 `compression_output`，只写入 `plan` 或 `explanation` 不算保留；hint 不能代替原文、伪造事实或把助手建议升级为用户授权。\n\n" +
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
      '  "to": "compressible_000130_q7",\n' +
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
        'Use "compact" for historical summaries, or "delete" to retire old process while retaining still-valid information'
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
