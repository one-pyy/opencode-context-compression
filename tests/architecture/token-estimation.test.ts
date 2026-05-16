import { strict as assert } from "node:assert";
import { test } from "node:test";

import { estimateEnvelopeTokens } from "../../src/token-estimation.js";
import type { TransformEnvelope } from "../../src/seams/noop-observation.js";

test("token estimation ignores reasoning parts", () => {
  const estimate = estimateEnvelopeTokens({
    envelope: {
      info: { id: "msg_1", role: "tool" },
      parts: [
        {
          type: "reasoning",
          text: "A".repeat(40),
        },
      ],
    } as unknown as TransformEnvelope,
  });

  assert.equal(estimate.tokenCount, 0);
});

test("token estimation uses tool input and output text", () => {
  const estimate = estimateEnvelopeTokens({
    envelope: {
      info: { id: "msg_1", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "read",
          callID: "call-1",
          state: {
            status: "completed",
            input: { filePath: "/tmp/example.ts" },
            output: "A".repeat(20),
          },
        },
      ],
    } as unknown as TransformEnvelope,
  });

  assert.equal(estimate.tokenCount, Math.ceil(renderModelVisiblePartsTextForTest().length / 4));
});

function renderModelVisiblePartsTextForTest(): string {
  return [
    '[tool call]\nname: read\ninput: {"filePath":"/tmp/example.ts"}',
    '[tool result]\nstatus: completed\noutput: ' + 'A'.repeat(20),
  ].join('\n');
}
