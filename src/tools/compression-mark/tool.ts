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
  readonly countTokens?: (input: CompressionMarkAdmissionInput) => number | undefined;
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
    tokenCount: options.countTokens?.(admissionInput) ?? null,
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
      "标记成功后，选区原文可能随时退出可见上下文。普通 compact 可由选区内明确结论与 hint 承接，无须另写摘要文件；结论须包含后续需要的结果、依据、约束和限制。仍需原文判断的内容保留。需要摘要之外完整保存、跨会话交付或独立恢复的原件，先按用途维护已有文件，缺少落点时才补记录。delete 的落盘要求见下文。\n" +
      "判断标准：后续是否只需明确结论、必要证据和资料入口，而不再需要选区内逐条细节。\n\n" +
      "## Prioritize marking:\n" +
      "完成、验证、提交或用户批准只表示结果稳定。先核对后续所需信息能否由选区内明确结论与 hint 承接，或已按独立恢复用途保存，再选择不再需要逐条细节的范围。\n" +
      "- Content the user explicitly asks to compress, or refers to with `cpmark`.\n" +
      "- Completed and verified code changes, bug fixes, configuration changes, or documentation writes, after the final result, verification evidence, and any reusable rationale have been reported or written to a durable place.\n" +
      "- Requirements the user has confirmed as complete, only when the accepted result no longer needs the preceding discussion details and the user has moved to an unrelated new request.\n" +
      "- Externalized and verified intermediate materials such as search results, analysis notes, report drafts, or implementation notes, when future work only needs the path and conclusion.\n" +
      "- Verbose tool output, repeated logs, and failed attempts, when the final conclusion, error cause, effective fix, or current state has been preserved and line-by-line detail is no longer needed.\n" +
      "- Exploration superseded by a final approach, when rejection reasons or key tradeoffs have been preserved.\n" +
      "- Completed subagent investigations, audits, batch searches, or long log analyses, when conclusions, file paths, and unresolved risks are enough.\n\n" +
      "## Do not mark:\n" +
      "- Context for the task currently in progress.\n" +
      "- 访谈、需求澄清、偏好、设计、验收标准或草案中仍需逐字使用、尚未形成明确结论，或需要独立保存却尚未保存的内容。\n" +
      "- Interview or design details that are externalized but still under user review, feedback, or direction changes.\n" +
      "- Errors, failing tests, debugging process, open assumptions, or option comparisons that are still unresolved and whose details are still needed for later judgment.\n" +
      "- Recent context needed to judge wording, boundaries, user intent, corrections, counterexamples, or acceptance criteria.\n\n" +
      "## If hard context pressure exists but all visible candidates are risky:\n" +
      "保留高风险范围并继续任务。确需独立恢复时，优先更新已有任务、运行记录、候选或证据载体；缺少落点才补按主题维护的短记录，保留约束、有效断点、必要原件和入口。临时工作材料也就地更新当前有效内容，替换失效状态，不追加操作流水账或覆盖链；原始日志和验证证据保留并引用。仅在选区满足保留标准后标记，随后立即继续原任务。\n\n" +
      "## How to identify message IDs:\n" +
      "Look for visible message IDs in the conversation history. They use the format `<visible-type>_<seq6>_<check_sum>`, where `<check_sum>` is a 2-character checksum suffix. Always include the visible-type prefix in `from` and `to`. Copy the sequence and checksum exactly; when an inspect entry omits the prefix, add `compressible_` for compact atoms or kind=compressible entries, and `protected_` for kind=user entries. Keep the `referable_` prefix on fragment endpoints. Mark endpoints may be host message IDs (`protected` or `compressible`) or the `referable_...~referable_...` range markers you currently see for applied compression results; a referable marker must match a current result and resolves to the source messages it covers. Examples: `protected_000001_q7`, `compressible_000002_m2`, `referable_000015_ab`.\n" +
      "The range is inclusive: both from and to messages are included. Example: To compress messages from compressible_000123_ab to compressible_000130_q7, use those as start/end IDs. If from and to are the same ID, that single visible message is targeted.\n\n" +
      "## Marking multiple segments:\n" +
      "压缩以完整任务、完整事件或多个已完成任务为单位。先确定任务或事件的语义边界，再整体标记其中符合条件的连续范围；不要逐条挑选消息，也不要把同一任务拆成多次小范围标记。跨 `compression_inspect` 的 atom、section 和 delete 条目选区，这些分段只用于统计，不决定 mark 边界；可以跨 protected 用户消息，compact 会保留其原文。仅为绕开仍需完整保留的 skill 正文或活跃上下文，或满足区间合法性与模型输入预算时，才拆成必要的少数几段。检查此前部分压缩任务的未处理残余，一并处理符合条件的内容。用 hint 指定整个范围必须保留的关键内容；第一轮批量标记所有符合条件的范围。若有标记被拒绝，按拒绝原因重新核验未处理内容与合法边界，可进行第二轮补标，最多两轮；第二轮不得重复已接受标记或盲目扩大冲突选区。\n" +
      "当前任务仍需直接使用的完整 skill 正文、协议或其他参考内容，可以保留在上下文中。通过缩短选区或拆成前后两个合法范围绕开这些内容，不必为了合并标记而纳入压缩；调整的是消息范围，不截断消息正文。已有 compact 标记及摘要片段仍须遵守相应的完整覆盖和区间冲突规则，不能任意切割。\n" +
      "成功但尚未应用的标记视为已处理，避免重复覆盖；已应用 compact 可完整纳入更大范围，compact 保持已有摘要，delete 可进一步提炼。部分交叉会被拒绝。delete 必须完整覆盖涉及的已有 compact 标记及摘要片段，不能严格落在已有 mark 内部；选区避开已有 delete。\n\n" +
      "## Protected messages:\n" +
      "Compact preserves protected originals. Delete may remove user originals, including short messages, so first verify that their still-valid meaning and scope will survive in the result or in checked, discoverable local materials. System messages remain protected.\n\n" +
      "## Delete range and preparation:\n" +
      "Delete can consume complete applied compact summaries plus uncovered originals. Include each summary fragment in full. A summary fragment shows up in context as a `[referable_...~referable_...]` range: pass those two markers as the range endpoints to consume it (a `compression_inspect` call with `mode=delete` lists each fragment's marker pair as its `from` and `to`), or use host visible IDs that bracket the whole fragment (the nearest visible messages before and after it). Either way the fragment must be covered completely. Write and verify still-valid requirements, preferences, conclusions, evidence boundaries and unresolved work in discoverable project-local files before marking; include file paths and essential current facts in hint. Once delete takes effect, compression_recall cannot retrieve its source range. Age or completion alone does not justify deletion. If the assembled input is too large, split it into independent legal ranges; a failed attempt leaves existing content available.\n\n" +
      "## Hint (optional):\n" +
      "通过 hint 明确指定选区内必须保留的关键事实、精确参数、用户约束、决定、证据限制、未决事项；有独立资料时保留完整路径和用途，并说明哪些过程可以简化。普通 compact 的明确结论可直接进入摘要；hint 不替代事实核对或需完整保存的原件。关键保留项必须进入最终 `compression_output`，只写入 `plan` 或 `explanation` 不算保留；hint 不能伪造事实或把助手建议升级为用户授权。\n\n" +
      "**Three types of hints:**\n" +
      "1. **任务完成 / 已外化** — 仅在结论、必要证据和理由已明确，且不再需要逐条细节时说明任务完成；有独立文件时附资料入口：\n" +
      "   - '修复已完成。保留选区结论中的根因、修复行为、验证结果与限制，精简实现过程；这些结论直接进入摘要。'\n" +
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
      '  "hint": "调查已完成。保留选区内最终方案、验证依据、可复用理由和用户约束，精简已被结论替代的探索过程。"\n' +
      "}\n" +
      "```\n\n" +
      "## What happens after:\n" +
      "- 成功返回 markId 和 tokenCount。tokenCount 是本次范围内可处理的词元估计：compact 仅计当前可见的可压缩原文，delete 计可见处理内容；不是实际净节省量。无法从当前会话投影确定时返回 null。按成功标记的非重叠覆盖量核对提醒建议，不把重复覆盖计为新增进度。\n" +
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
