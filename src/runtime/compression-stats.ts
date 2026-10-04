import { rename, writeFile } from "node:fs/promises";

import type { ProjectedMessageSet } from "../projection/types.js";
import { estimateTextTokensWithService } from "../token-estimation.js";
import { TokenCounter } from "../utils/token-counter.js";
import {
  resolvePluginStateDirectory,
  resolveSessionStatsPath,
} from "./sidecar-layout.js";

export type TextTokenEstimator = (text: string) => Promise<number>;

// 优先用本地 tiktoken 服务；服务不可用时退回字符近似（与插件其它处一致）。
const estimateTextTokens: TextTokenEstimator = async (text) => {
  const estimate = await estimateTextTokensWithService({ text });
  return estimate?.tokenCount ?? new TokenCounter().countTokens(text);
};

export interface CompressionStatsSnapshot {
  readonly sessionID: string;
  /** 不可压：保护类（system / 短用户消息）+ delete 替换文本。 */
  readonly protectedTokenCount: number;
  /** 可delete：已压缩的摘要（compact result-group）。 */
  readonly deletableTokenCount: number;
  /** 可压：未被标记覆盖、未被保护、仍留在请求里的可压消息（text + tool）。 */
  readonly compressibleTokenCount: number;
  /** reasoning：可压消息里的 reasoning token（单独一行显示，不并入 comp）。 */
  readonly reasoningTokenCount: number;
  readonly updatedAt: string;
}

export async function computeCompressionStats(
  projection: ProjectedMessageSet,
  updatedAt: string,
  estimate: TextTokenEstimator = estimateTextTokens,
): Promise<CompressionStatsSnapshot> {
  const policyByCanonicalId = new Map(
    projection.state.messagePolicies.map((policy) => [policy.canonicalId, policy]),
  );

  // 逐条估算占用。可压 canonical 用 policy.tokenCount（text + tool）再加 reasoning；
  // 保护类与摘要文本没有 policy，用同一估算器现算。
  const perMessage = await Promise.all(
    projection.messages.map(async (message) => {
      if (message.source === "canonical" && message.canonicalId !== undefined) {
        const policy = policyByCanonicalId.get(message.canonicalId);
        if (policy?.visibleKind === "compressible") {
          // comp 用 policy.tokenCount（text + tool）；reasoning 单独统计、单独显示。
          const reasoning = await estimateReasoningTokens(message.parts, estimate);
          return { bucket: "compressible" as const, tokens: policy.tokenCount, reasoning };
        }
        if (policy?.visibleKind === "protected") {
          return { bucket: "protected" as const, tokens: await estimate(message.contentText), reasoning: 0 };
        }
        return undefined;
      }
      if (message.source === "result-group") {
        const tokens = await estimate(message.contentText);
        return {
          bucket:
            message.visibleKind === "referable"
              ? ("deletable" as const)
              : ("protected" as const),
          tokens,
          reasoning: 0,
        };
      }
      return undefined;
    }),
  );

  let protectedTokenCount = 0;
  let deletableTokenCount = 0;
  let compressibleTokenCount = 0;
  let reasoningTokenCount = 0;
  for (const entry of perMessage) {
    if (entry === undefined) continue;
    if (entry.bucket === "protected") protectedTokenCount += entry.tokens;
    else if (entry.bucket === "deletable") deletableTokenCount += entry.tokens;
    else compressibleTokenCount += entry.tokens;
    reasoningTokenCount += entry.reasoning;
  }

  return {
    sessionID: projection.sessionId,
    protectedTokenCount,
    deletableTokenCount,
    compressibleTokenCount,
    reasoningTokenCount,
    updatedAt,
  };
}

async function estimateReasoningTokens(
  parts: readonly { type?: string; text?: string }[] | undefined,
  estimate: TextTokenEstimator,
): Promise<number> {
  const text = (parts ?? [])
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("\n");
  return text.length === 0 ? 0 : estimate(text);
}

export async function writeCompressionStats(options: {
  readonly pluginDirectory: string;
  readonly stats: CompressionStatsSnapshot;
}): Promise<void> {
  const stateDirectory = resolvePluginStateDirectory(options.pluginDirectory);
  const filePath = resolveSessionStatsPath(
    stateDirectory,
    options.stats.sessionID,
  );
  // 先写临时文件再 rename，避免 TUI 读到半写内容。
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(options.stats)}\n`, "utf8");
  await rename(tempPath, filePath);
}
