import { rename, writeFile } from "node:fs/promises";

import type { ProjectedMessageSet } from "../projection/types.js";
import { estimateTextTokenCount } from "../token-estimation.js";
import {
  resolvePluginStateDirectory,
  resolveSessionStatsPath,
} from "./sidecar-layout.js";

export type TextTokenEstimator = (text: string) => Promise<number>;

// 优先用本地 tiktoken 服务；服务不可用时退回字符近似（与插件其它处一致）。
const estimateTextTokens: TextTokenEstimator = estimateTextTokenCount;

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

const MAX_STATS_TOKEN_ESTIMATIONS = 16;

export function createCompressionStatsScheduler(input: {
  readonly compute: (projection: ProjectedMessageSet, updatedAt: string) => Promise<CompressionStatsSnapshot>;
  readonly write: (stats: CompressionStatsSnapshot) => Promise<void>;
  readonly onPublished?: (stats: CompressionStatsSnapshot) => Promise<void>;
  readonly onError?: (error: unknown, sessionID: string) => void;
}): (projection: ProjectedMessageSet) => void {
  const pending = new Map<string, ProjectedMessageSet>();
  const running = new Set<string>();

  const drain = async (sessionID: string): Promise<void> => {
    try {
      while (pending.has(sessionID)) {
        const projection = pending.get(sessionID);
        if (!projection) break;
        pending.delete(sessionID);
        try {
          const stats = await input.compute(projection, new Date().toISOString());
          if (!pending.has(sessionID)) {
            await input.write(stats);
            if (!pending.has(sessionID)) await input.onPublished?.(stats);
          }
        } catch (error) {
          input.onError?.(error, sessionID);
        }
      }
    } finally {
      running.delete(sessionID);
      if (pending.has(sessionID)) {
        running.add(sessionID);
        void drain(sessionID);
      }
    }
  };

  return (projection) => {
    const sessionID = projection.sessionId;
    pending.set(sessionID, projection);
    if (running.has(sessionID)) return;
    running.add(sessionID);
    void drain(sessionID);
  };
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
  const perMessage = await mapWithConcurrency(
    projection.messages,
    MAX_STATS_TOKEN_ESTIMATIONS,
    async (message) => {
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
        if (message.visibleKind === "referable" && projection.deletableTokenCount !== undefined) {
          return undefined;
        }
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
    },
  );

  let protectedTokenCount = 0;
  let deletableTokenCount = projection.deletableTokenCount ?? 0;
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

async function mapWithConcurrency<Input, Output>(
  input: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(input.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, input.length) }, async () => {
      while (nextIndex < input.length) {
        const index = nextIndex++;
        const value = input[index];
        if (value !== undefined) output[index] = await map(value);
      }
    }),
  );
  return output;
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
