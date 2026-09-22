import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  parseAnthropicSseChunk,
  parseGeminiSseChunk,
  parseOpenAISseChunk,
  readStreamingText,
} from "../../src/compaction/transport/direct-llm.js";
import type { RuntimeArtifactRecorder } from "../../src/runtime/runtime-artifacts.js";

const stubArtifacts = {
  writeDiagnostic: async () => {},
} as unknown as RuntimeArtifactRecorder;

test("OpenAI-compatible reasoning deltas are recognized as progress", () => {
  assert.deepEqual(
    parseOpenAISseChunk(
      JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: "think" } }] }),
    ),
    { text: "", reasoning: "think" },
  );
  assert.deepEqual(
    parseOpenAISseChunk(JSON.stringify({ choices: [{ delta: { content: "answer" } }] })),
    { text: "answer", reasoning: "" },
  );
});

test("Anthropic thinking deltas are recognized as progress", () => {
  assert.deepEqual(
    parseAnthropicSseChunk(
      JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }),
    ),
    { text: "", reasoning: "hmm" },
  );
  assert.deepEqual(
    parseAnthropicSseChunk(
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "out" } }),
    ),
    { text: "out", reasoning: "" },
  );
});

test("Gemini thought parts are separated from text parts", () => {
  assert.deepEqual(
    parseGeminiSseChunk(
      JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: "think" }] } }] }),
    ),
    { text: "", reasoning: "think" },
  );
  assert.deepEqual(
    parseGeminiSseChunk(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "out" }] } }] }),
    ),
    { text: "out", reasoning: "" },
  );
});

test("reasoning-only frames keep the stream alive past the first-token timeout", async () => {
  const reasoningFrame = JSON.stringify({
    choices: [{ delta: { content: null, reasoning_content: "think " } }],
  });
  const contentFrame = JSON.stringify({
    choices: [{ delta: { content: '{"plan":"P","compression_output":"C"}' } }],
  });

  const frames = [
    ...Array.from({ length: 8 }, () => ({ delayMs: 50, data: reasoningFrame })),
    { delayMs: 50, data: contentFrame },
    { delayMs: 0, data: "[DONE]" },
  ];

  const text = await readStreamingText(
    sseResponse(frames),
    stubArtifacts,
    {
      sessionID: "session-progress",
      markID: "mark-progress",
      model: "deepseek/deepseek-flash",
      executionMode: "compact",
      promptText: "prompt",
      transcript: [],
      timeoutMs: 5_000,
      firstTokenTimeoutMs: 300,
      streamIdleTimeoutMs: 300,
    },
    parseOpenAISseChunk,
  );

  assert.equal(text, '{"plan":"P","compression_output":"C"}');
});

function sseResponse(
  frames: ReadonlyArray<{ readonly delayMs: number; readonly data: string }>,
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= frames.length) {
        controller.close();
        return;
      }
      const frame = frames[index]!;
      index += 1;
      if (frame.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, frame.delayMs));
      }
      controller.enqueue(encoder.encode(`data: ${frame.data}\n\n`));
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
