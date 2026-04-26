import { strict as assert } from "node:assert";
import { test } from "node:test";

import { estimateEnvelopeTokens } from "../../src/token-estimation.js";
import type { TransformEnvelope } from "../../src/seams/noop-observation.js";

test("token estimation includes tool_result content in the flattened text view", () => {
  const estimate = estimateEnvelopeTokens({
    envelope: {
      info: { id: "msg_1", role: "tool" },
      parts: [
        {
          type: "tool_result",
          content: "A".repeat(40),
        },
      ],
    } as unknown as TransformEnvelope,
  });

  assert.equal(estimate.tokenCount, 10);
});

test("token estimation includes reasoning text in the flattened text view", () => {
  const estimate = estimateEnvelopeTokens({
    envelope: {
      info: { id: "msg_1", role: "assistant" },
      parts: [
        {
          type: "reasoning",
          text: "A".repeat(20),
        },
      ],
    } as unknown as TransformEnvelope,
  });

  assert.equal(estimate.tokenCount, 5);
});
