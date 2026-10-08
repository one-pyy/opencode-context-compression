import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateEnvelopeTokensWithService,
  estimateTextTokensWithService,
} from "../../src/token-estimation.js";
import { createFlatPolicyEngine } from "../../src/projection/policy-engine.js";
import { computeCompressionStats } from "../../src/runtime/compression-stats.js";
import { checkCompactionInputBudget } from "../../src/compaction/transport/input-budget.js";
import type { TransformEnvelope } from "../../src/seams/noop-observation.js";

test("successful text counts are shared and do not expire with time", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ tokens: 42 }));
  const input = { text: "shared-count", endpoint: "http://cache.test/shared" };
  const first = await estimateTextTokensWithService(input);
  t.mock.method(Date, "now", () => 99_999_999_999_999);
  assert.deepEqual(await estimateTextTokensWithService(input), first);
  assert.deepEqual(first, { tokenCount: 42, source: "python-tiktoken" });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("complete text, model and effective endpoint isolate counts", async (t) => {
  let requests = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ tokens: ++requests }));
  const inputs = [
    { text: "identity", endpoint: "http://cache.test/keys" },
    { text: "identity+", endpoint: "http://cache.test/keys" },
    { text: "identity", endpoint: "http://cache.test/keys", modelName: "model-b" },
    { text: "identity", endpoint: "http://cache.test/other" },
    { text: "identity", endpoint: "http://cache.test/keys", modelName: "" },
    { text: "\ud800", endpoint: "http://cache.test/keys" },
    { text: "\ud801", endpoint: "http://cache.test/keys" },
  ];
  for (const [index, input] of inputs.entries()) {
    assert.equal((await estimateTextTokensWithService(input))?.tokenCount, index + 1);
  }
  for (const [index, input] of inputs.entries()) {
    assert.equal((await estimateTextTokensWithService(input))?.tokenCount, index + 1);
  }
  assert.equal(fetchMock.mock.callCount(), inputs.length);
});

test("environment endpoint changes do not reuse another service's count", async (t) => {
  const oldEndpoint = process.env.OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL;
  t.after(() => {
    if (oldEndpoint === undefined) delete process.env.OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL;
    else process.env.OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL = oldEndpoint;
  });
  let count = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ tokens: ++count }));
  process.env.OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL = "http://cache.test/env-a";
  assert.equal((await estimateTextTokensWithService({ text: "env-count" }))?.tokenCount, 1);
  process.env.OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL = "http://cache.test/env-b";
  assert.equal((await estimateTextTokensWithService({ text: "env-count" }))?.tokenCount, 2);
  assert.equal((await estimateTextTokensWithService({ text: "env-count", endpoint: "http://cache.test/env-a" }))?.tokenCount, 1);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("failed estimates are retried and never retained as approximate counts", async (t) => {
  const failures = [
    async () => { throw new DOMException("timeout", "TimeoutError"); },
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response("invalid json"),
    async () => Response.json({ tokens: "wrong" }),
    async () => Response.json({ tokens: 1.5 }),
  ];
  for (const [index, failure] of failures.entries()) {
    let healthy = false;
    const mock = t.mock.method(globalThis, "fetch", () => healthy ? Promise.resolve(Response.json({ tokens: 17 })) : failure());
    const input = { text: `failure-${index}`, endpoint: `http://cache.test/failure-${index}` };
    assert.equal(await estimateTextTokensWithService(input), undefined);
    healthy = true;
    assert.equal((await estimateTextTokensWithService(input))?.tokenCount, 17);
    assert.equal((await estimateTextTokensWithService(input))?.tokenCount, 17);
    assert.equal(mock.mock.callCount(), 2);
    mock.mock.restore();
  }
});

test("empty text and cached zero avoid requests while preserving accepted values", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ tokens: -1 }));
  assert.equal((await estimateTextTokensWithService({ text: "" }))?.tokenCount, 0);
  assert.equal(mock.mock.callCount(), 0);
  const input = { text: "zero-count", endpoint: "http://cache.test/zero" };
  assert.equal((await estimateTextTokensWithService(input))?.tokenCount, 0);
  assert.equal((await estimateTextTokensWithService(input))?.tokenCount, 0);
  assert.equal(mock.mock.callCount(), 1);
});

test("cold concurrent calls keep independent signals and reverse completion stays isolated", async (t) => {
  const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal | null | undefined }> = [];
  const mock = t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
    if (pending.length >= 3) {
      return Promise.resolve(Response.json({ tokens: String(init?.body).includes("new-concurrent") ? 22 : 11 }));
    }
    return new Promise<Response>((resolve) => {
      pending.push({ resolve, signal: init?.signal });
    });
  });
  const oldInput = { text: "old-concurrent", endpoint: "http://cache.test/concurrent", timeoutMs: 500 };
  const newInput = { ...oldInput, text: "new-concurrent", timeoutMs: 900 };
  const old = estimateTextTokensWithService(oldInput);
  const current = estimateTextTokensWithService(newInput);
  const duplicate = estimateTextTokensWithService(oldInput);
  assert.equal(pending.length, 3);
  assert.notEqual(pending[0]?.signal, pending[2]?.signal);
  pending[1]!.resolve(Response.json({ tokens: 22 }));
  assert.equal((await current)?.tokenCount, 22);
  pending[2]!.resolve(Response.json({ tokens: 11 }));
  pending[0]!.resolve(Response.json({ tokens: 11 }));
  assert.equal((await old)?.tokenCount, 11);
  assert.equal((await duplicate)?.tokenCount, 11);
  assert.equal((await estimateTextTokensWithService(oldInput))?.tokenCount, 11);
  assert.equal((await estimateTextTokensWithService(newInput))?.tokenCount, 22);
  assert.equal(mock.mock.callCount(), 3);
});

test("unchanged histories share counts across sessions and preserve classification and stats", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ tokens: 10 }));
  const history = {
    sessionId: "cache-session-a", marks: [], compressionMarkToolCalls: [],
    messages: Array.from({ length: 1000 }, (_, index) => {
      const text = `history-cache-content-${index}`;
      const hostMessage = { info: { id: `history-${index}`, role: "assistant" as const }, parts: [{ type: "text", text }] };
      return { sequence: index + 1, canonicalId: hostMessage.info.id, role: "assistant" as const, contentText: text, parts: hostMessage.parts, hostMessage };
    }),
  };
  const engine = createFlatPolicyEngine();
  const cold = await engine.classifyMessages(history);
  const coldRequests = mock.mock.callCount();
  assert.equal(coldRequests, 1000);
  const hot = await engine.classifyMessages({ ...history, sessionId: "cache-child-session" });
  assert.deepEqual(hot, cold);
  assert.equal(mock.mock.callCount(), coldRequests);
  const changed = { ...history, messages: [...history.messages] };
  const first = changed.messages[0]!;
  changed.messages[0] = { ...first, hostMessage: { ...first.hostMessage, parts: [{ type: "text", text: "history-cache-new-content" }] } };
  await engine.classifyMessages(changed);
  assert.equal(mock.mock.callCount(), coldRequests + 1);

  const projection = {
    sessionId: "stats-cache-session",
    messages: [
      { source: "canonical", canonicalId: "protected", contentText: "cache-protected" },
      { source: "canonical", canonicalId: "comp", contentText: "cache-comp", parts: [{ type: "reasoning", text: "cache-reasoning" }] },
      { source: "result-group", visibleKind: "referable", contentText: "cache-summary" },
      { source: "result-group", contentText: "cache-delete-summary" },
    ],
    state: { messagePolicies: [
      { canonicalId: "protected", visibleKind: "protected", tokenCount: 0 },
      { canonicalId: "comp", visibleKind: "compressible", tokenCount: 33 },
    ] },
  } as unknown as Parameters<typeof computeCompressionStats>[0];
  const coldStats = await computeCompressionStats(projection, "cold");
  const statsRequests = mock.mock.callCount();
  const hotStats = await computeCompressionStats(projection, "hot");
  assert.deepEqual(hotStats, { ...coldStats, updatedAt: "hot" });
  assert.equal(hotStats.protectedTokenCount, 20);
  assert.equal(hotStats.deletableTokenCount, 10);
  assert.equal(hotStats.compressibleTokenCount, 33);
  assert.equal(hotStats.reasoningTokenCount, 10);
  assert.equal(mock.mock.callCount(), statsRequests);
});

test("streaming tool content invalidates counts but metadata and reasoning do not", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ tokens: 8 }));
  const tool = { type: "tool", tool: "read", callID: "cache-call", state: { status: "running", input: { path: "a" }, output: "partial", metadata: { n: 1 } } };
  const reasoning = { type: "reasoning", text: "r1" };
  const envelope = { info: { id: "cache-stream-id", role: "assistant" }, parts: [tool, reasoning] } as unknown as TransformEnvelope;
  const estimate = () => estimateEnvelopeTokensWithService({ envelope, endpoint: "http://cache.test/stream" });
  await estimate();
  tool.state.metadata.n = 2;
  reasoning.text = "r2";
  await estimate();
  assert.equal(mock.mock.callCount(), 1);
  tool.state.output = "complete";
  await estimate();
  tool.state.status = "completed";
  await estimate();
  tool.state.input.path = "b";
  await estimate();
  assert.equal(mock.mock.callCount(), 4);
});

test("budget and envelope fallbacks remain separate and recover to successful counts", async (t) => {
  let healthy = false;
  const mock = t.mock.method(globalThis, "fetch", async () => healthy ? Response.json({ tokens: 20 }) : new Response("offline", { status: 503 }));
  const input = { model: "cache-budget-model", systemPrompt: "中文预算", userMessage: "cache-budget-body", inputTokenLimit: 20 };
  await assert.rejects(checkCompactionInputBudget(input), /exceeds model budget/u);
  const envelope = { info: { id: "fallback", role: "assistant" }, parts: [{ type: "text", text: "cache-fallback-text" }] } as unknown as TransformEnvelope;
  const estimateInput = { envelope, endpoint: "http://cache.test/envelope-fallback" };
  assert.equal((await estimateEnvelopeTokensWithService(estimateInput)).source, "character-approximation");
  healthy = true;
  await checkCompactionInputBudget(input);
  await checkCompactionInputBudget(input);
  await checkCompactionInputBudget({ ...input, inputTokenLimit: 21 });
  await assert.rejects(checkCompactionInputBudget({ ...input, inputTokenLimit: 19 }), /exceeds model budget/u);
  assert.equal((await estimateEnvelopeTokensWithService(estimateInput)).source, "python-tiktoken");
  assert.equal(mock.mock.callCount(), 4);
});
