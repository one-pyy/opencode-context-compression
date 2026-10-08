import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginInput } from "@opencode-ai/plugin";
import { loadRuntimeConfig, RUNTIME_CONFIG_ENV } from "../../src/config/runtime-config.js";
import { CPMARK_REMINDER_TEXT, sendCpmarkReminder } from "../../src/runtime/cpmark-reminder.js";
import type { CompressionStatsSnapshot } from "../../src/runtime/compression-stats.js";

type PromptRequest = Parameters<PluginInput["client"]["session"]["prompt"]>[0];

const promptContext = {
  agent: "sisyphus", model: { providerID: "openai", modelID: "gpt-6.1-sol" },
  variant: "high", tools: { bash: true, task: false },
};
const history = { data: [
  { info: { role: "user", ...promptContext, variant: "low" } },
  { info: { role: "user", ...promptContext } },
  { info: { role: "assistant", providerID: "other", modelID: "other" } },
] };

function stats(total: number, fixed = 10_000, sessionID = "session-a"): CompressionStatsSnapshot {
  return {
    sessionID, protectedTokenCount: fixed, deletableTokenCount: 15_000,
    compressibleTokenCount: total - 15_000, reasoningTokenCount: 500_000,
    updatedAt: new Date().toISOString(),
  };
}

test("cpmark reminder uses strict upper bound, hysteresis and persisted session isolation", async (t) => {
  const pluginDirectory = await mkdtemp(join(tmpdir(), "cpmark-reminder-"));
  t.after(() => rm(pluginDirectory, { recursive: true, force: true }));
  const sent: PromptRequest[] = [];
  const pluginInput = {
    directory: "/host-project",
    client: { session: {
      messages: async () => history,
      prompt: async (request: PromptRequest) => { sent.push(request); },
    } },
  } as unknown as PluginInput;
  const check = (value: CompressionStatsSnapshot) => sendCpmarkReminder({
    stats: value, threshold: 190_000,
    databasePath: join(pluginDirectory, `${value.sessionID}.db`), pluginInput,
  });

  await check(stats(173_500));
  await check(stats(200_000));
  assert.equal(sent.length, 0);
  await check(stats(200_001));
  assert.deepEqual(sent[0], {
    path: { id: "session-a" }, query: { directory: "/host-project" },
    body: { noReply: true, ...promptContext, parts: [{ type: "text", text: CPMARK_REMINDER_TEXT }] },
    throwOnError: true,
  });
  await check(stats(230_000));
  await check(stats(170_001));
  await check(stats(200_001));
  assert.equal(sent.length, 1);

  // 每次调用重新打开数据库，不依赖进程内状态，覆盖重启后的去重。
  await check(stats(170_000));
  assert.equal(sent.length, 1);
  await check(stats(200_001));
  assert.equal(sent.length, 2);
  await check(stats(200_001, 10_000, "session-b"));
  assert.equal(sent.length, 3);
  assert.equal(sent[2]?.path.id, "session-b");
});

test("cpmark reminder retries failed delivery and follows current fixed and custom threshold", async (t) => {
  const pluginDirectory = await mkdtemp(join(tmpdir(), "cpmark-retry-"));
  t.after(() => rm(pluginDirectory, { recursive: true, force: true }));
  let calls = 0;
  const pluginInput = {
    directory: "/host-project",
    client: { session: { messages: async () => history, prompt: async () => {
      calls += 1;
      if (calls === 1) throw new Error("delivery failed");
    } } },
  } as unknown as PluginInput;
  const check = (total: number, fixed: number) => sendCpmarkReminder({
    stats: stats(total, fixed), threshold: 100_000,
    databasePath: join(pluginDirectory, "session-a.db"), pluginInput,
  });
  await check(150_000, 50_000);
  assert.equal(calls, 0);
  await assert.rejects(check(150_001, 50_000), /delivery failed/);
  await check(150_001, 50_000);
  await check(150_001, 50_000);
  assert.equal(calls, 2);
  await check(150_001, 80_001);
  await check(150_001, 50_000);
  assert.equal(calls, 3);
});

test("cpmark reminder preserves pending delivery when session context is unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cpmark-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let reads = 0;
  const sent: PromptRequest[] = [];
  const pluginInput = {
    directory: "/host-project",
    client: { session: {
      messages: async () => {
        reads += 1;
        if (reads === 1) throw new Error("history unavailable");
        if (reads === 2) return { data: [] };
        return { data: [{ info: { role: "user", agent: promptContext.agent, model: promptContext.model } }] };
      },
      prompt: async (request: PromptRequest) => { sent.push(request); },
    } },
  } as unknown as PluginInput;
  const check = () => sendCpmarkReminder({
    stats: stats(200_001), threshold: 190_000,
    databasePath: join(directory, "session-a.db"), pluginInput,
  });
  await assert.rejects(check(), /history unavailable/);
  await assert.rejects(check(), /without a user message/);
  assert.equal(sent.length, 0);
  await check();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.body, {
    noReply: true, agent: promptContext.agent, model: promptContext.model,
    parts: [{ type: "text", text: CPMARK_REMINDER_TEXT }],
  });
});

test("cpmark threshold config defaults, overrides and rejects invalid values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cpmark-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const load = async (reminder: Record<string, unknown>) => {
    await writeFile(configPath, JSON.stringify({
      version: 1, promptPath: "prompts/compaction.md",
      compactionModels: ["provider/model"], reminder,
    }));
    return loadRuntimeConfig({ [RUNTIME_CONFIG_ENV.configPath]: configPath });
  };
  assert.equal((await load({})).reminder.cpmarkThreshold, 190_000);
  assert.equal((await load({ cpmarkThreshold: 123_000 })).reminder.cpmarkThreshold, 123_000);
  for (const cpmarkThreshold of [0, -1, 1.5, "invalid"]) {
    await assert.rejects(load({ cpmarkThreshold }), /cpmarkThreshold must be a positive integer/);
  }
});
