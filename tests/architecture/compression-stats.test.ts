import { strict as assert } from "node:assert";
import { test } from "node:test";

import { computeCompressionStats } from "../../src/runtime/compression-stats.js";

// 固定用字符近似，避免测试依赖本地 tiktoken 服务。
const charEstimate = async (text: string) => Math.ceil(text.length / 4);

test("compression stats reuse the current projection's precomputed del without estimating summaries again", async () => {
  const projection = {
    sessionId: "precomputed",
    deletableTokenCount: 60_001,
    messages: [
      { source: "result-group", role: "assistant", visibleKind: "referable", contentText: "already counted" },
      { source: "result-group", role: "assistant", contentText: "delete output" },
    ],
    state: { messagePolicies: [] },
  } as unknown as Parameters<typeof computeCompressionStats>[0];
  const texts: string[] = [];
  const stats = await computeCompressionStats(projection, "t", async (text) => {
    texts.push(text);
    return 7;
  });
  assert.equal(stats.deletableTokenCount, 60_001);
  assert.equal(stats.protectedTokenCount, 7);
  assert.deepEqual(texts, ["delete output"]);
});

test("compression stats split 不可压 / 可delete / 可压", async () => {
  const projection = {
    sessionId: "s1",
    messages: [
      // 不可压：保护类（system / 短用户）
      { source: "canonical", role: "system", canonicalId: "c1", contentText: "x".repeat(40) },
      // 可压：未被标记覆盖、仍在请求里的可压消息（reasoning 单独统计）
      {
        source: "canonical",
        role: "assistant",
        canonicalId: "c2",
        contentText: "y".repeat(20),
        parts: [{ type: "reasoning", text: "z".repeat(80) }],
      },
      // 可delete：compact 摘要（referable）
      { source: "result-group", role: "assistant", visibleKind: "referable", contentText: "x".repeat(400) },
      // 不可压：delete 替换文本
      { source: "result-group", role: "assistant", contentText: "x".repeat(20) },
      // 忽略：reminder
      { source: "reminder", role: "assistant", contentText: "reminder" },
    ],
    state: {
      messagePolicies: [
        { canonicalId: "c1", sequence: 1, role: "system", visibleKind: "protected", tokenCount: 0 },
        { canonicalId: "c2", sequence: 2, role: "assistant", visibleKind: "compressible", tokenCount: 42 },
      ],
    },
  } as unknown as Parameters<typeof computeCompressionStats>[0];

  const stats = await computeCompressionStats(projection, "2026-01-01T00:00:00.000Z", charEstimate);
  // 不可压 = system 40/4=10 + delete 替换 20/4=5
  assert.equal(stats.protectedTokenCount, 15);
  // 可delete = 摘要 400/4=100
  assert.equal(stats.deletableTokenCount, 100);
  // 可压 = policy 里已算好的 tokenCount（含工具输入/输出），不含 reasoning
  assert.equal(stats.compressibleTokenCount, 42);
  // reasoning = 80/4=20，单独统计
  assert.equal(stats.reasoningTokenCount, 20);
});

test("compression stats ignore reminder and synthetic messages", async () => {
  const projection = {
    sessionId: "s2",
    messages: [
      { source: "canonical", role: "system", canonicalId: "c1", contentText: "x".repeat(40) },
      { source: "synthetic", role: "user", contentText: "x".repeat(4000) },
      { source: "reminder", role: "assistant", contentText: "x".repeat(4000) },
    ],
    state: {
      messagePolicies: [
        { canonicalId: "c1", sequence: 1, role: "system", visibleKind: "protected", tokenCount: 0 },
      ],
    },
  } as unknown as Parameters<typeof computeCompressionStats>[0];

  const stats = await computeCompressionStats(projection, "t", charEstimate);
  assert.equal(stats.protectedTokenCount, 10);
  assert.equal(stats.deletableTokenCount, 0);
  assert.equal(stats.compressibleTokenCount, 0);
});

test("compression stats bound concurrent token estimates without dropping messages", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const projection = {
    sessionId: "many",
    messages: Array.from({ length: 40 }, (_, index) => ({
      source: "result-group",
      role: "assistant",
      visibleKind: "referable",
      contentText: `summary-${index}`,
    })),
    state: { messagePolicies: [] },
  } as unknown as Parameters<typeof computeCompressionStats>[0];
  const stats = await computeCompressionStats(projection, "t", async () => {
    active += 1;
    calls += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return 1;
  });

  assert.equal(maxActive, 16);
  assert.equal(calls, 40);
  assert.equal(stats.deletableTokenCount, 40);
});
