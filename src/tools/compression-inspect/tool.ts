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
      "Provide the to visible message ID as an inclusive upper bound. 成功清单使用 TSV，列为类型、起点、终点、token数；行按消息先后排列。统计区间不决定 mark 边界。" +
      "默认 compact 模式显示上界内首个至最后一个可压缩条目之间的 compressible 与 referable 区间，隐藏 protected 消息；protected 与 referable 均隔开连续原文区间。referable 行携带完整摘要端点，帮助检查已有覆盖。没有可压缩条目时返回空表。Set mergeAdjacent=false to receive per-message token counts. " +
      "delete 模式显示上界内所有 compressible 与 referable 区间，包括边缘摘要；两种模式均隐藏 protected 行，保护消息仍隔开连续原文区间。mergeAdjacent 不改变 delete 清单。类型沿用 compressible、referable；端点保持原 inspect 格式：原文用裸编号，摘要保留 referable 标记对。" +
      "提醒复用同一清单：compressible 用于 compact，referable 用于检查摘要退役。compact 原文使用策略 token 数，referable 和 delete 条目使用当前可见文本计数。表外总计为显示行之和，不等同于面板摘要计数；用户约束仍须从上下文核对。Reuse an attached listing when it covers the intended range. " +
      "After inspecting a range, either call compression_mark or leave the range unchanged. " +
      "Do not repeatedly inspect the same range unless new visible messages were added or the range boundaries changed. " +
      "compression_mark records a future compaction request; it does not immediately change the current visible context.",
    args: {
      to: tool.schema.string().min(1).describe(
        "Inclusive upper bound; compact shows first-to-last visible compressible span within it, delete shows all compressible and referable entries up to it"
      ),
      mode: tool.schema.enum(["compact", "delete"]).optional().default("compact").describe(
        "compact (default) shows compressible and intervening referable ranges; delete includes edge summaries. Both hide protected rows"
      ),
      mergeAdjacent: tool.schema.boolean().optional().default(true).describe(
        "Merge consecutive compressible messages; protected and referable entries break ranges. Defaults to true; delete ignores this flag"
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
