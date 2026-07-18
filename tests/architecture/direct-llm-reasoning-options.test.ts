import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildOpenAICompatibleRequestBody } from "../../src/compaction/transport/direct-llm.js";

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
  assert.deepEqual(requestBody.messages, [
    { role: "system", content: "system" },
    { role: "user", content: "user" },
  ]);
  assert.equal(requestBody.stream, true);
});
