import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildCompactionRunInputForMark } from "../../src/compaction/replay-run-input.js";
import { replayHistoryFromSources, type CanonicalHostMessage } from "../../src/history/history-replay-reader.js";
import { renderModelVisiblePartsText } from "../../src/model-visible-transcript.js";
import { createFlatPolicyEngine } from "../../src/projection/policy-engine.js";
import { estimateEnvelopeTokens } from "../../src/token-estimation.js";
import type { ProjectionState } from "../../src/projection/types.js";
import type { TransformEnvelope } from "../../src/seams/noop-observation.js";

test("model-visible transcript keeps text plus generic tool input and output", () => {
  const rendered = renderModelVisiblePartsText([
    { type: "text", text: "assistant text" },
    createToolPart({
      tool: "apply_patch",
      input: { patchText: "*** Begin Patch\n-old\n+new\n*** End Patch" },
      output: "Success. Updated the following files:\nM src/example.ts",
    }),
  ]);

  assert.match(rendered, /assistant text/u);
  assert.match(rendered, /\[tool call\]\nname: apply_patch/u);
  assert.match(rendered, /input: \{"patchText":"\*\*\* Begin Patch/u);
  assert.match(rendered, /\[tool result\]\nstatus: completed/u);
  assert.match(rendered, /output: Success\. Updated/u);
});

test("model-visible transcript drops host metadata and keeps generic tool fields", () => {
  const rendered = renderModelVisiblePartsText([
    createToolPart({
      tool: "apply_patch",
      input: { patchText: "change" },
      output: "done",
      metadata: {
        diagnostics: "Import pandas could not be resolved".repeat(10),
        diff: "duplicate diff",
      },
      title: "done",
      time: { start: 1 },
    }),
  ]);

  assert.match(rendered, /name: apply_patch/u);
  assert.match(rendered, /input: \{"patchText":"change"\}/u);
  assert.match(rendered, /output: done/u);
  assert.doesNotMatch(rendered, /metadata/u);
  assert.doesNotMatch(rendered, /diagnostics/u);
  assert.doesNotMatch(rendered, /pandas/u);
  assert.doesNotMatch(rendered, /title/u);
  assert.doesNotMatch(rendered, /call-1/u);
});

test("model-visible transcript truncates large input and output by head and tail", () => {
  const input = `input-head-${"a".repeat(24_000)}-input-tail`;
  const output = `output-head-${"b".repeat(24_000)}-output-tail`;

  const rendered = renderModelVisiblePartsText([
    createToolPart({ tool: "bash", input, output }),
  ]);

  assert.match(rendered, /input-head/u);
  assert.match(rendered, /input-tail/u);
  assert.match(rendered, /output-head/u);
  assert.match(rendered, /output-tail/u);
  assert.match(rendered, /omitted \d+ chars from \d+ total/u);
  assert.ok(rendered.length < input.length + output.length);
});

test("compaction run input uses the same model-visible renderer for text and tool parts", () => {
  const message = createMessage("msg-assistant", "assistant", [
    { type: "text", text: "visible text" },
    createToolPart({
      tool: "read",
      input: { filePath: "/tmp/example.ts" },
      output: "file contents",
      metadata: { diagnostics: "huge diagnostics" },
    }),
  ]);
  const state = createProjectionState(message);

  const runInput = buildCompactionRunInputForMark({
    sessionId: "session-1",
    state,
    markId: "mark-1",
    model: "provider/model",
    promptText: "compress",
    timeoutMs: 1_000,
  });

  const contentText = runInput.build.transcript[0]?.contentText ?? "";
  assert.match(contentText, /visible text/u);
  assert.match(contentText, /name: read/u);
  assert.match(contentText, /input: \{"filePath":"\/tmp\/example\.ts"\}/u);
  assert.match(contentText, /output: file contents/u);
  assert.doesNotMatch(contentText, /metadata/u);
  assert.doesNotMatch(contentText, /huge diagnostics/u);
});

test("token estimation shares the model-visible renderer with compaction input", () => {
  const parts = [
    { type: "text", text: "visible text" },
    createToolPart({
      tool: "bash",
      input: { command: "npm test" },
      output: "tests passed",
      metadata: { diagnostics: "not model visible" },
    }),
  ];
  const rendered = renderModelVisiblePartsText(parts);
  const estimate = estimateEnvelopeTokens({
    envelope: {
      info: { id: "msg", role: "assistant" },
      parts,
    } as unknown as TransformEnvelope,
  });

  assert.equal(estimate.tokenCount, Math.ceil(rendered.length / 4));
});

test("policy token counts use the model-visible renderer while projection text stays text-only", async () => {
  const parts = [
    { type: "text", text: "visible text" },
    createToolPart({
      tool: "bash",
      input: { command: "npm test" },
      output: "tests passed",
      metadata: { diagnostics: "not model visible" },
    }),
  ];
  const history = replayHistoryFromSources({
    sessionId: "session-1",
    hostHistory: [
      {
        sequence: 1,
        message: createMessage("msg-assistant", "assistant", parts),
      },
    ],
    toolHistory: [],
  });
  const rendered = renderModelVisiblePartsText(parts);
  const tokenCounterInputs: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const body = init?.body;
    if (typeof body !== "string") {
      throw new Error("Expected token counter request body to be a JSON string.");
    }
    const payload = JSON.parse(body) as { readonly text?: unknown };
    if (typeof payload.text !== "string") {
      throw new Error("Expected token counter request payload to include text.");
    }
    tokenCounterInputs.push(payload.text);
    return new Response(JSON.stringify({ tokens: 123 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) satisfies typeof fetch;

  let policies: Awaited<ReturnType<ReturnType<typeof createFlatPolicyEngine>["classifyMessages"]>>;
  try {
    policies = await createFlatPolicyEngine().classifyMessages(history);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(history.messages[0]?.contentText, "visible text");
  assert.equal(tokenCounterInputs[0], rendered);
  assert.equal(policies[0]?.tokenCount, 123);
});

test("metadata diagnostics do not affect rendered transcript size", () => {
  const smallMetadata = renderModelVisiblePartsText([
    createToolPart({
      tool: "apply_patch",
      input: { patchText: "change" },
      output: "done",
      metadata: { diagnostics: "short" },
    }),
  ]);
  const hugeMetadata = renderModelVisiblePartsText([
    createToolPart({
      tool: "apply_patch",
      input: { patchText: "change" },
      output: "done",
      metadata: { diagnostics: "x".repeat(1_000_000) },
    }),
  ]);

  assert.equal(hugeMetadata, smallMetadata);
  assert.ok(hugeMetadata.length < 1_000);
});

test("generic renderer works for different tool names without specialization", () => {
  const rendered = renderModelVisiblePartsText([
    createToolPart({ tool: "apply_patch", input: { patchText: "p" }, output: "ok" }),
    createToolPart({ tool: "bash", input: { command: "pwd" }, output: "/repo" }),
    createToolPart({ tool: "read", input: { filePath: "a.ts" }, output: "content" }),
  ]);

  assert.match(rendered, /name: apply_patch/u);
  assert.match(rendered, /name: bash/u);
  assert.match(rendered, /name: read/u);
  assert.match(rendered, /input: \{"patchText":"p"\}/u);
  assert.match(rendered, /input: \{"command":"pwd"\}/u);
  assert.match(rendered, /input: \{"filePath":"a\.ts"\}/u);
});

function createToolPart(input: {
  readonly tool: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly metadata?: unknown;
  readonly title?: unknown;
  readonly time?: unknown;
}) {
  return {
    type: "tool",
    tool: input.tool,
    callID: "call-1",
    metadata: { openai: { itemId: "provider-item" } },
    state: {
      status: "completed",
      input: input.input,
      output: input.output,
      metadata: input.metadata,
      title: input.title,
      time: input.time,
    },
  };
}

function createMessage(
  id: string,
  role: "system" | "user" | "assistant" | "tool",
  parts: CanonicalHostMessage["parts"],
): CanonicalHostMessage {
  return {
    info: { id, role },
    parts,
  };
}

function createProjectionState(message: CanonicalHostMessage): ProjectionState {
  const history = replayHistoryFromSources({
    sessionId: "session-1",
    hostHistory: [{ sequence: 1, message }],
    toolHistory: [],
  });

  return {
    sessionId: "session-1",
    history,
    markTree: {
      conflicts: [],
      marks: [
        {
          markId: "mark-1",
          mode: "compact",
          startVisibleMessageId: "compressible_000001_aa",
          endVisibleMessageId: "compressible_000001_aa",
          sourceMessageId: "mark-tool",
          sourceSequence: 2,
          startSequence: 1,
          endSequence: 1,
          depth: 0,
          children: [],
        },
      ],
    },
    conflicts: [],
    messagePolicies: [
      {
        canonicalId: "msg-assistant",
        sequence: 1,
        role: "assistant",
        visibleKind: "compressible",
        tokenCount: 1,
        visibleId: "compressible_000001_aa",
        visibleSeq: 1,
        visibleBase62: "aa",
      },
    ],
    visibleIdAllocations: [],
    resultGroups: [],
    failedToolMessageIds: new Map(),
  };
}
