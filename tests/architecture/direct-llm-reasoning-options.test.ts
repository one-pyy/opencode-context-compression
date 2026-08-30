import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildOpenAICompatibleRequestBody } from "../../src/compaction/transport/direct-llm.js";
import { parseCompactionJsonPayload } from "../../src/compaction/transport/validation.js";

test("DeepSeek-compatible requests use medium reasoning effort", () => {
  assert.equal(
    buildOpenAICompatibleRequestBody("deepseek", "model-a", "system", "user")
      .reasoning_effort,
    "medium",
  );
  assert.equal(
    buildOpenAICompatibleRequestBody("custom-proxy", "deepseek-r1", "system", "user")
      .reasoning_effort,
    "medium",
  );
  assert.equal(
    buildOpenAICompatibleRequestBody("DEEPSEEK", "MODEL-A", "system", "user")
      .reasoning_effort,
    "medium",
  );
});

test("other OpenAI-compatible requests keep none reasoning effort", () => {
  const requestBody = buildOpenAICompatibleRequestBody(
    "custom-proxy",
    "model-a",
    "system",
    "user",
  );

  assert.equal(requestBody.reasoning_effort, "none");
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
  assert.deepEqual(requestBody.messages, [
    { role: "system", content: "system" },
    { role: "user", content: "user" },
  ]);
  assert.equal(requestBody.stream, true);
});

test("compaction JSON payload is split into fields while retaining raw text", () => {
  const rawContentText = JSON.stringify({
    plan: "Check the source windows.",
    compression_output: "Summary with <compression_output> inside the text.",
    explanation: "The output is ready.",
  });

  const parsed = parseCompactionJsonPayload(rawContentText, {
    sessionID: "session-1",
    markID: "mark-1",
    model: "model-1",
    executionMode: "compact",
    promptText: "prompt",
    transcript: [],
    timeoutMs: 1_000,
  });

  assert.deepEqual(parsed, {
    plan: "Check the source windows.",
    compression_output: "Summary with <compression_output> inside the text.",
    explanation: "The output is ready.",
    rawContentText,
  });
});
