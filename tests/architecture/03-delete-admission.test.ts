import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createCompressionMarkAdmission } from "../../src/tools/compression-mark/tool.js";
import { renderProjectionMessages } from "../../src/projection/rendering.js";
import type { ReplayedHistory, ReplayedHistoryMessage } from "../../src/history/history-replay-reader.js";
import type { MarkTree, MarkTreeNode, MessageProjectionPolicy } from "../../src/projection/types.js";
import type { CompleteResultGroup } from "../../src/state/result-group-repository.js";

test("Admission Gate - allowDelete: false rejects delete mode", async () => {
  const admission = createCompressionMarkAdmission({ allowDelete: false });
  const result = await admission({
    sessionID: "ses_1",
    mode: "delete",
    from: "vis_1",
    to: "vis_2",
  });
  
  assert.equal("ok" in result && result.ok, false, "Implementation violates 6.2: Must return an error when allowDelete=false and mode=delete");
  // We DO NOT assert specific error codes like "DELETE_NOT_ALLOWED" because DESIGN.md does not mandate the exact string.
});

test("Admission Gate - allowDelete: true allows delete mode", async () => {
  const admission = createCompressionMarkAdmission({ allowDelete: true });
  const result = await admission({
    sessionID: "ses_1",
    mode: "delete",
    from: "vis_1",
    to: "vis_2",
  });
  
  assert.equal((result as any).ok, true);
});

test("Admission Gate - compact mode is always allowed", async () => {
  const admission = createCompressionMarkAdmission({ allowDelete: false });
  const result = await admission({
    sessionID: "ses_1",
    mode: "compact",
    from: "vis_1",
    to: "vis_2",
  });
  
  assert.equal((result as any).ok, true);
});

// Helper functions for Projection Rendering test
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

function createMarkNode(id: string, startSeq: number, endSeq: number): MarkTreeNode {
  return {
    markId: id,
    mode: "delete", // Mark node represents a delete action
    startVisibleMessageId: `compressible_00000${startSeq}_xxx`,
    endVisibleMessageId: `compressible_00000${endSeq}_xxx`,
    sourceMessageId: `msg_${endSeq}`,
    sourceSequence: endSeq,
    startSequence: startSeq,
    endSequence: endSeq,
    depth: 1,
    children: []
  };
}

function createDeleteResultGroup(markId: string, startSeq: number, endSeq: number, notice: string): CompleteResultGroup {
  return {
    markId,
    mode: "delete",
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
        replacementText: notice // The minimalistic delete notice
      }
    ]
  };
}

test("Delete Rendering - Completely Strips Source", () => {
  const messages = [createMsg(1, "U1"), createMsg(2, "DELETE_TARGET"), createMsg(3, "U2")];
  const policies = [createPolicy(1), createPolicy(2), createPolicy(3)];
  const history: ReplayedHistory = { sessionId: "ses_test", messages, marks: [], compressionMarkToolCalls: [] };
  
  const mDelete = createMarkNode("m_delete", 2, 2);
  const markTree: MarkTree = { marks: [mDelete], conflicts: [] };
  
  const resultGroups = new Map<string, CompleteResultGroup>([
    ["m_delete", createDeleteResultGroup("m_delete", 2, 2, "[Message Deleted]")]
  ]);

  const output = renderProjectionMessages({ history, messagePolicies: policies, markTree, resultGroupsByMarkId: resultGroups });
  
  // Output should be U1, [Message Deleted], U2
  assert.equal(output.messages.length, 3);
  assert.equal(output.messages[0].contentText.includes("U1"), true);
  
  // Check the rendered message for the deleted block
  const deletedMsg = output.messages[1];
  assert.equal(deletedMsg.source, "result-group");
  // The rendering logic for mode="delete" strips the visibleId prefix, outputting raw notice
  assert.equal(deletedMsg.contentText, "[Message Deleted]");
  // The rendering logic removes the visibleKind and visibleId entirely for mode="delete"
  assert.equal(deletedMsg.visibleId, undefined); 
  
  assert.equal(output.messages[2].contentText.includes("U2"), true);
});
