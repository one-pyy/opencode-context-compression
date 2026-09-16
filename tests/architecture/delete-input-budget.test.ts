import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCompactionInputBudget, resolveCompactionInputBudget } from "../../src/compaction/transport/input-budget.js";

test("delete budget uses input limit or context minus output reservation", () => {
  assert.equal(resolveCompactionInputBudget({ input: 80, context: 100, output: 30 }), 80);
  assert.equal(resolveCompactionInputBudget({ context: 100, output: 30 }), 70);
  assert.equal(resolveCompactionInputBudget(undefined), undefined);
  assert.equal(resolveCompactionInputBudget({ context: 100 }), undefined);
  assert.throws(() => resolveCompactionInputBudget({ context: 20, output: 30 }), /positive integer/);
});

test("delete budget measures assembled prompts, accepts the boundary and rejects overflow without truncation", async (t) => {
  const measured: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    measured.push(JSON.parse(String(init.body)).text);
    return new Response(JSON.stringify({ tokens: 100 }));
  });
  const input = { model: "provider/model", systemPrompt: "delete rules", userMessage: "summary plus uncovered originals" };
  await checkCompactionInputBudget({ ...input, inputTokenLimit: 100 });
  await assert.rejects(checkCompactionInputBudget({ ...input, inputTokenLimit: 99 }), /exceeds model budget/);
  assert.equal(measured.length, 2);
  assert.deepEqual(JSON.parse(measured[0]), [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: input.userMessage },
  ]);
  assert.equal(measured[0], measured[1]);
});

test("delete budget uses conservative byte count when token service fails and skips unknown budgets", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("counter unavailable"); });
  const input = { model: "provider/model", systemPrompt: "规则", userMessage: "保留用户偏好" };
  await checkCompactionInputBudget(input);
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(checkCompactionInputBudget({ ...input, inputTokenLimit: 1 }), /exceeds model budget/);
  await checkCompactionInputBudget({ ...input, inputTokenLimit: 1000 });
  assert.equal(fetch.mock.callCount(), 2);
});
