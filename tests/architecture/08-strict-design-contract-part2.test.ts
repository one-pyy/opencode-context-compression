import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderProjectionMessages } from "../../src/projection/rendering.js";
import type { ReplayedHistory, ReplayedHistoryMessage } from "../../src/history/history-replay-reader.js";
import type { MarkTree, MessageProjectionPolicy } from "../../src/projection/types.js";
import type { CompleteResultGroup } from "../../src/state/result-group-repository.js";

// Helper to create fake messages
function createMsg(seq: number, content: string, role: "user"|"assistant" = "user"): ReplayedHistoryMessage {
  return {
    sequence: seq,
    canonicalId: `msg_${seq}`,
    role,
    contentText: content,
    hostMessage: {
      info: { id: `msg_${seq}`, role },
      parts: [{ type: "text", text: content }]
    }
  };
}

function createPolicy(seq: number, role: "user"|"assistant" = "user"): MessageProjectionPolicy {
  return {
    canonicalId: `msg_${seq}`,
    sequence: seq,
    role,
    visibleKind: "compressible",
    tokenCount: 10,
    visibleId: `compressible_00000${seq}_xx`,
    visibleSeq: seq,
    visibleBase62: "xx"
  };
}

// 契约测试 1：纯工具调用的合成壳 (DESIGN.md 2.4 & 14.13)
// 契约：“当模型只发出 tool 调用而没有 assistant 文本时，projection 必须补一条简短的合成 assistant 消息（只含 id）。”
test("DESIGN.md Contract 2.4 & 14.13 - Tool-only assistant MUST have a synthetic text shell", () => {
  // Simulate an assistant message that has NO text, representing a tool-only call.
  const emptyAssistantMsg = createMsg(1, "", "assistant");
  const policies = [createPolicy(1, "assistant")];
  
  const history: ReplayedHistory = { sessionId: "ses_1", messages: [emptyAssistantMsg], marks: [], compressionMarkToolCalls: [] };
  const markTree: MarkTree = { marks: [], conflicts: [] };
  const resultGroups = new Map<string, CompleteResultGroup>();

  const output = renderProjectionMessages({ history, messagePolicies: policies, markTree, resultGroupsByMarkId: resultGroups, failedToolMessageIds: new Set() });
  
  assert.equal(output.messages.length, 1, "Should output exactly 1 message for the assistant");
  
  const renderedText = output.messages[0].contentText;
  
  // Design says it must prepend the visible ID to ensure the model sees an anchor.
  // Example: "[compressible_000001_xx]"
  assert.ok(
    renderedText.includes("[compressible_000001_xx]"), 
    `Implementation violates 2.4: Expected synthetic shell with visible ID, but got: '${renderedText}'`
  );
  
  // Design also explicitly says: "这条 assistant 壳文本只写 visible id 本身，不要再写 'Calling <tool>' 之类额外说明"
  assert.equal(
    renderedText.trim(),
    "[compressible_000001_xx]",
    `Implementation violates 2.4: Shell must contain ONLY the visible ID, no extra text. Got: '${renderedText}'`
  );
});

// 契约测试 2：Metadata 不是跨轮真相源 (DESIGN.md 9.5)
// 契约：“不要把临时 metadata 当成 mark、replacement... 的长期依据。跨轮真相在 SQLite sidecar”
// 这是一个黑盒逻辑断言：即使用户/模型在消息的某种附带结构里声称自己被压缩了，只要 SQLite (ResultGroups) 里没有，就必须回退原文。
test("DESIGN.md Contract 9.5 - Metadata is NOT truth, must rely on Sidecar ResultGroups", () => {
  const msg = createMsg(1, "Original Text");
  // Injecting fake metadata that claims it was compacted (simulating a dirty state or legacy metadata)
  (msg.hostMessage as any).metadata = { compression_mark: "m1", status: "compacted" };
  
  const policies = [createPolicy(1)];
  const history: ReplayedHistory = { sessionId: "ses_1", messages: [msg], marks: [], compressionMarkToolCalls: [] };
  
  // The crucial part: Sidecar (ResultGroups) is EMPTY!
  const markTree: MarkTree = { marks: [], conflicts: [] };
  const resultGroups = new Map<string, CompleteResultGroup>();

  const output = renderProjectionMessages({ history, messagePolicies: policies, markTree, resultGroupsByMarkId: resultGroups, failedToolMessageIds: new Set() });
  
  // The system MUST ignore the dirty metadata and render the original text.
  assert.ok(
    output.messages[0].contentText.includes("Original Text"),
    "Implementation violates 9.5: System trusted dirty metadata instead of the empty Sidecar."
  );
});

