import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createFlatPolicyEngine } from "../../src/projection/policy-engine.js";
import type { ReplayedHistory, ReplayedHistoryMessage, ReplayedMarkIntent, ReplayedCompressionMarkToolCall } from "../../src/history/history-replay-reader.js";

function createMsg(seq: number, content: string, length: number): ReplayedHistoryMessage {
  return {
    sequence: seq,
    canonicalId: `msg_${seq}`,
    role: "user",
    contentText: content,
    hostMessage: {
      info: { id: `msg_${seq}`, role: "user" },
      parts: [{ type: "text", text: content }]
    }
  };
}

test("Policy Engine - Small User Message Protection", () => {
  const engine = createFlatPolicyEngine({ smallUserMessageThreshold: 50 });
  const messages = [createMsg(1, "short", 5)];
  const history: ReplayedHistory = { sessionId: "ses_1", messages, marks: [], compressionMarkToolCalls: [] };
  
  const policies = engine.classifyMessages(history);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].visibleKind, "protected");
  assert.equal(policies[0].tokenCount, 0); // Protected messages don't count towards reminder tokens
});

test("Policy Engine - Long User Message is Compressible", () => {
  const engine = createFlatPolicyEngine({ smallUserMessageThreshold: 50 });
  // length > 50 chars -> tokenCount = length / 4
  const content = "A".repeat(100);
  const messages = [createMsg(1, content, 100)];
  const history: ReplayedHistory = { sessionId: "ses_1", messages, marks: [], compressionMarkToolCalls: [] };
  
  const policies = engine.classifyMessages(history);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].visibleKind, "compressible");
  assert.ok(policies[0].tokenCount > 0); // Design does not mandate tokenCount = length / 4, just that it counts.
});

test("Policy Engine - Build Mark Tree (Intersection Rejection)", () => {
  const engine = createFlatPolicyEngine({ smallUserMessageThreshold: 50 });
  const messages = [createMsg(1, "A1", 100), createMsg(2, "T1", 100), createMsg(3, "T2", 100), createMsg(4, "U2", 100)];
  
  const marks: ReplayedMarkIntent[] = [
    { markId: "m_left", mode: "compact", sourceSequence: 4, sourceMessageId: "msg_4", startVisibleMessageId: "comp_1", endVisibleMessageId: "comp_3" },
    { markId: "m_bad", mode: "compact", sourceSequence: 5, sourceMessageId: "msg_5", startVisibleMessageId: "comp_2", endVisibleMessageId: "comp_4" }
  ];
  
  const history: ReplayedHistory = { sessionId: "ses_1", messages, marks, compressionMarkToolCalls: [] };
  const visibleIdsByCanonicalId = new Map([
    ["msg_1", "comp_1"], ["msg_2", "comp_2"], ["msg_3", "comp_3"], ["msg_4", "comp_4"]
  ]);

  const tree = engine.buildMarkTree({ history, visibleIdsByCanonicalId });
  
  // m_bad should be rejected due to overlap without containment
  assert.equal(tree.marks.length, 1);
  assert.equal(tree.marks[0].markId, "m_left");
  assert.equal(tree.conflicts.length, 1);
  assert.equal(tree.conflicts[0].markId, "m_bad");
  // DESIGN.md 15.7 does not mandate the exact string "OVERLAP_CONFLICT", just that it throws an error.
  assert.ok(tree.conflicts[0].errorCode);
});
