import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderProjectionMessages } from "../../src/projection/rendering.js";
import type { ReplayedHistory, ReplayedHistoryMessage } from "../../src/history/history-replay-reader.js";
import type { MarkTree, MarkTreeNode, MessageProjectionPolicy } from "../../src/projection/types.js";
import type { CompleteResultGroup } from "../../src/state/result-group-repository.js";

// Helper to create a fake canonical message
function createMsg(seq: number, content: string): ReplayedHistoryMessage {
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

function createPolicy(seq: number): MessageProjectionPolicy {
  return {
    canonicalId: `msg_${seq}`,
    sequence: seq,
    role: "user",
    visibleKind: "compressible",
    tokenCount: 10,
    visibleId: `compressible_00000${seq}_xxx`,
    visibleSeq: seq,
    visibleBase62: "xxx"
  };
}

function createMarkNode(id: string, startSeq: number, endSeq: number, children: MarkTreeNode[] = []): MarkTreeNode {
  return {
    markId: id,
    mode: "compact",
    startVisibleMessageId: `compressible_00000${startSeq}_xxx`,
    endVisibleMessageId: `compressible_00000${endSeq}_xxx`,
    sourceMessageId: `msg_${endSeq}`,
    sourceSequence: endSeq,
    startSequence: startSeq,
    endSequence: endSeq,
    depth: 1,
    children
  };
}

function createResultGroup(markId: string, startSeq: number, endSeq: number, replacementText: string): CompleteResultGroup {
  return {
    markId,
    mode: "compact",
    sourceStartSeq: startSeq,
    sourceEndSeq: endSeq,
    fragmentCount: 1,
    executionMode: "auto",
    createdAt: new Date().toISOString(),
    payloadSha256: "hash",
    fragments: [
      {
        markId,
        fragmentIndex: 0,
        sourceStartSeq: startSeq,
        sourceEndSeq: endSeq,
        replacementText
      }
    ]
  };
}

test("Coverage Tree Render - Basic Compact (15.28)", () => {
  const messages = [createMsg(1, "U1"), createMsg(2, "A1"), createMsg(3, "T1"), createMsg(4, "U2")];
  const policies = [createPolicy(1), createPolicy(2), createPolicy(3), createPolicy(4)];
  const history: ReplayedHistory = { sessionId: "ses_test", messages, marks: [], compressionMarkToolCalls: [] };
  
  const m1 = createMarkNode("m1", 2, 3);
  const markTree: MarkTree = { marks: [m1], conflicts: [] };
  
  const resultGroups = new Map<string, CompleteResultGroup>([
    ["m1", createResultGroup("m1", 2, 3, "COMPACTED_A1_T1")]
  ]);

  const output = renderProjectionMessages({ history, messagePolicies: policies, markTree, resultGroupsByMarkId: resultGroups });
  
  assert.equal(output.messages.length, 3);
  assert.equal(output.messages[0].contentText.includes("U1"), true);
  assert.equal(output.messages[1].source, "result-group");
  assert.equal(output.messages[1].contentText.includes("COMPACTED_A1_T1"), true);
  assert.equal(output.messages[2].contentText.includes("U2"), true);
});

test("Coverage Tree Render - Big Covers Small - Big Pending (15.29)", () => {
  const messages = [createMsg(1, "U1"), createMsg(2, "A1"), createMsg(3, "T1"), createMsg(4, "U2")];
  const policies = [createPolicy(1), createPolicy(2), createPolicy(3), createPolicy(4)];
  const history: ReplayedHistory = { sessionId: "ses_test", messages, marks: [], compressionMarkToolCalls: [] };
  
  const mSmall = createMarkNode("m_small", 2, 3);
  const mBig = createMarkNode("m_big", 1, 4, [mSmall]);
  const markTree: MarkTree = { marks: [mBig], conflicts: [] };
  
  // Only small has result, big is pending
  const resultGroups = new Map<string, CompleteResultGroup>([
    ["m_small", createResultGroup("m_small", 2, 3, "COMPACTED_SMALL")]
  ]);

  const output = renderProjectionMessages({ history, messagePolicies: policies, markTree, resultGroupsByMarkId: resultGroups });
  
  // Output should fallback to U1, COMPACTED_SMALL, U2
  assert.equal(output.messages.length, 3);
  assert.equal(output.messages[0].contentText.includes("U1"), true);
  assert.equal(output.messages[1].contentText.includes("COMPACTED_SMALL"), true);
  assert.equal(output.messages[2].contentText.includes("U2"), true);
});

test("Coverage Tree Render - Big Covers Small - Big Ready (15.30)", () => {
  const messages = [createMsg(1, "U1"), createMsg(2, "A1"), createMsg(3, "T1"), createMsg(4, "U2")];
  const policies = [createPolicy(1), createPolicy(2), createPolicy(3), createPolicy(4)];
  const history: ReplayedHistory = { sessionId: "ses_test", messages, marks: [], compressionMarkToolCalls: [] };
  
  const mSmall = createMarkNode("m_small", 2, 3);
  const mBig = createMarkNode("m_big", 1, 4, [mSmall]);
  const markTree: MarkTree = { marks: [mBig], conflicts: [] };
  
  // Both have results. Big should swallow small.
  const resultGroups = new Map<string, CompleteResultGroup>([
    ["m_small", createResultGroup("m_small", 2, 3, "COMPACTED_SMALL")],
    ["m_big", createResultGroup("m_big", 1, 4, "COMPACTED_BIG")]
  ]);

  const output = renderProjectionMessages({ history, messagePolicies: policies, markTree, resultGroupsByMarkId: resultGroups });
  
  assert.equal(output.messages.length, 1);
  assert.equal(output.messages[0].source, "result-group");
  assert.equal(output.messages[0].contentText.includes("COMPACTED_BIG"), true);
});

test("Coverage Tree Render - Gap Merging and Fragments (15.18 & 15.33)", () => {
  const messages = [createMsg(1, "U1"), createMsg(2, "C1"), createMsg(3, "U2")];
  const policies = [createPolicy(1), createPolicy(2), createPolicy(3)];
  const history: ReplayedHistory = { sessionId: "ses_test", messages, marks: [], compressionMarkToolCalls: [] };
  
  const m1 = createMarkNode("m1", 1, 3);
  const markTree: MarkTree = { marks: [m1], conflicts: [] };
  
  // A result group with 2 fragments, skipping message 2 (C1)
  const resultGroups = new Map<string, CompleteResultGroup>([
    ["m1", {
      markId: "m1",
      mode: "compact",
      sourceStartSeq: 1,
      sourceEndSeq: 3,
      fragmentCount: 2,
      executionMode: "auto",
      createdAt: new Date().toISOString(),
      payloadSha256: "hash",
      fragments: [
        { markId: "m1", fragmentIndex: 0, sourceStartSeq: 1, sourceEndSeq: 1, replacementText: "FRAG_1" },
        { markId: "m1", fragmentIndex: 1, sourceStartSeq: 3, sourceEndSeq: 3, replacementText: "FRAG_2" }
      ]
    }]
  ]);

  const output = renderProjectionMessages({ history, messagePolicies: policies, markTree, resultGroupsByMarkId: resultGroups });
  
  // Should interleave Frag 1, Original C1, Frag 2
  assert.equal(output.messages.length, 3);
  assert.equal(output.messages[0].contentText.includes("FRAG_1"), true);
  assert.equal(output.messages[1].source, "canonical");
  assert.equal(output.messages[1].contentText.includes("C1"), true);
  assert.equal(output.messages[2].contentText.includes("FRAG_2"), true);
});
