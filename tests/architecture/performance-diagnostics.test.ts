import assert from "node:assert/strict";
import test from "node:test";
import { getPerformanceTrace, measurePerformanceStage, withPerformanceTrace } from "../../src/performance-diagnostics.js";

test("performance diagnostics are opt-in and isolate concurrent requests", async () => {
  const previous = process.env.OPENCODE_CONTEXT_COMPRESSION_PERF;
  try {
    delete process.env.OPENCODE_CONTEXT_COMPRESSION_PERF;
    let emitted = 0;
    assert.equal(await withPerformanceTrace(async () => { emitted += 1; }, async () => 7), 7);
    assert.equal(emitted, 0);
    process.env.OPENCODE_CONTEXT_COMPRESSION_PERF = "1";
    const outputs: Record<string, unknown>[] = [];
    await Promise.all([3, 8].map((calls) => withPerformanceTrace(
      async (payload) => { outputs.push(payload); },
      async () => {
        const trace = getPerformanceTrace();
        assert.ok(trace);
        trace.tokens.calls = calls;
        await measurePerformanceStage("test.stage", async () => { await Promise.resolve(); });
        assert.equal(getPerformanceTrace()?.tokens.calls, calls);
      },
    )));
    assert.deepEqual(outputs.map((output) => (output.tokens as { calls: number }).calls).sort(), [3, 8]);
    assert.equal(getPerformanceTrace(), undefined);
    const failure = new Error("original failure");
    await assert.rejects(withPerformanceTrace(async () => { throw new Error("recorder failure"); }, async () => { throw failure; }), (error) => error === failure);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONTEXT_COMPRESSION_PERF;
    else process.env.OPENCODE_CONTEXT_COMPRESSION_PERF = previous;
  }
});
