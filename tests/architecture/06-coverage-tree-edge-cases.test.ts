import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderProjectionMessages } from "../../src/projection/rendering.js";
import type { ReplayedHistory, ReplayedHistoryMessage } from "../../src/history/history-replay-reader.js";
import type { MarkTree, MarkTreeNode, MessageProjectionPolicy } from "../../src/projection/types.js";
import type { CompleteResultGroup } from "../../src/state/result-group-repository.js";

function createMsg(seq: number, content: string): ReplayedHistoryMessage {
  return {
    sequence: seq,
    canonicalId: `msg_${seq}`,
    role: "user", contentText: content, parts: [], hostMessage: {
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

test("Edge Case: Identical Range Override (15.31)", () => {
  const messages = [createMsg(1, "A1"), createMsg(2, "T1")];
  const policies = [createPolicy(1), createPolicy(2)];
  const history: ReplayedHistory = { sessionId: "ses_test", messages, marks: [], compressionMarkToolCalls: [] };
  
  // m_old was created first, m_new created second with EXACT same range
  const mOld = createMarkNode("m_old", 1, 2);
  const mNew = createMarkNode("m_new", 1, 2, [mOld]);
  const markTree: MarkTree = { marks: [mNew], conflicts: [] };
  
  // Only m_old has result. m_new is pending.
  const resultGroups = new Map<string, CompleteResultGroup>([
    ["m_old", createResultGroup("m_old", 1, 2, "OLD_COMPACT")]
  ]);

  const output = renderProjectionMessages({ history, messagePolicies: policies, markTree, resultGroupsByMarkId: resultGroups, failedToolMessageIds: new Map() });
  
  // It should elegantly fallback to m_old
  assert.equal(output.messages.length, 1);
  assert.equal(output.messages[0].contentText.includes("OLD_COMPACT"), true);
});

test("Edge Case: Invalid Child Swallowed Completely (15.14 & 15.34)", () => {
  const messages = [createMsg(1, "A1"), createMsg(2, "T1"), createMsg(3, "A2")];
  const policies = [createPolicy(1), createPolicy(2), createPolicy(3)];
  const history: ReplayedHistory = { sessionId: "ses_test", messages, marks: [], compressionMarkToolCalls: [] };
  
  // Big mark covers everything and is complete
  const mSmall = createMarkNode("m_small", 2, 2);
  const mBig = createMarkNode("m_big", 1, 3, [mSmall]);
  const markTree: MarkTree = { marks: [mBig], conflicts: [] };
  
  // Both have results
  const resultGroups = new Map<string, CompleteResultGroup>([
    ["m_small", createResultGroup("m_small", 2, 2, "SHOULD_BE_HIDDEN")],
    ["m_big", createResultGroup("m_big", 1, 3, "BIG_COMPACT")]
  ]);

  const output = renderProjectionMessages({ history, messagePolicies: policies, markTree, resultGroupsByMarkId: resultGroups, failedToolMessageIds: new Map() });
  
  // The small result MUST NOT appear. Once a parent is complete, subtree is swallowed.
  assert.equal(output.messages.length, 1);
  assert.equal(output.messages[0].contentText.includes("BIG_COMPACT"), true);
  assert.equal(output.messages[0].contentText.includes("SHOULD_BE_HIDDEN"), false);
});
