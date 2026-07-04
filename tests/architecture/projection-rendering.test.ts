import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReplayedHistoryMessage } from "../../src/history/history-replay-reader.js";
import { renderProjectionMessages } from "../../src/projection/rendering.js";
import type {
  MarkTree,
  MarkTreeNode,
  MessageProjectionPolicy,
} from "../../src/projection/types.js";
import type { CompleteResultGroup } from "../../src/state/result-group-repository.js";

function createMessage(
  sequence: number,
  role: "user" | "assistant",
  contentText: string,
): ReplayedHistoryMessage {
  return {
    sequence,
    canonicalId: `msg_${sequence}`,
    role,
    contentText,
    parts: [{ type: "text", text: contentText }],
    hostMessage: {
      info: { id: `msg_${sequence}`, role },
      parts: [{ type: "text", text: contentText }],
    },
  };
}

function createPolicy(
  message: ReplayedHistoryMessage,
  visibleKind: "protected" | "compressible",
): MessageProjectionPolicy {
  return {
    canonicalId: message.canonicalId,
    sequence: message.sequence,
    role: message.role,
    visibleKind,
    tokenCount: visibleKind === "protected" ? 0 : 10,
    visibleId: `${visibleKind}_${String(message.sequence).padStart(6, "0")}_aa`,
    visibleSeq: message.sequence,
    visibleBase62: "aa",
  };
}

function createMarkNode(input: {
  markId: string;
  startSequence: number;
  endSequence: number;
  children?: readonly MarkTreeNode[];
}): MarkTreeNode {
  return {
    markId: input.markId,
    mode: "compact",
    startVisibleMessageId: `compressible_${String(input.startSequence).padStart(6, "0")}_aa`,
    endVisibleMessageId: `compressible_${String(input.endSequence).padStart(6, "0")}_aa`,
    sourceMessageId: `${input.markId}_source`,
    sourceSequence: input.endSequence + 1,
    startSequence: input.startSequence,
    endSequence: input.endSequence,
    depth: 0,
    children: input.children ?? [],
  };
}

function createResultGroup(input: {
  markId: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  fragments: ReadonlyArray<{
    sourceStartSeq: number;
    sourceEndSeq: number;
    replacementText: string;
  }>;
}): CompleteResultGroup {
  return {
    markId: input.markId,
    mode: "compact",
    sourceStartSeq: input.sourceStartSeq,
    sourceEndSeq: input.sourceEndSeq,
    fragmentCount: input.fragments.length,
    executionMode: "compact",
    createdAt: "2026-07-04T00:00:00.000Z",
    payloadSha256: "test",
    applied: true,
    fragments: input.fragments.map((fragment, fragmentIndex) => ({
      fragmentIndex,
      ...fragment,
    })),
  };
}

test("Projection rendering preserves protected parent gaps when child marks are nested", () => {
  const messages = [
    createMessage(1, "assistant", "first compressible block"),
    createMessage(2, "assistant", "second compressible block"),
    createMessage(3, "user", "keep this user instruction"),
    createMessage(4, "assistant", "third compressible block"),
    createMessage(5, "assistant", "fourth compressible block"),
  ];
  const childNode = createMarkNode({
    markId: "child_mark",
    startSequence: 3,
    endSequence: 3,
  });
  const parentNode = createMarkNode({
    markId: "parent_mark",
    startSequence: 1,
    endSequence: 5,
    children: [childNode],
  });
  const markTree: MarkTree = { marks: [parentNode], conflicts: [] };
  const resultGroupsByMarkId = new Map<string, CompleteResultGroup>([
    [
      "parent_mark",
      createResultGroup({
        markId: "parent_mark",
        sourceStartSeq: 1,
        sourceEndSeq: 5,
        fragments: [
          { sourceStartSeq: 1, sourceEndSeq: 2, replacementText: "parent summary before gap" },
          { sourceStartSeq: 4, sourceEndSeq: 5, replacementText: "parent summary after gap" },
        ],
      }),
    ],
    [
      "child_mark",
      createResultGroup({
        markId: "child_mark",
        sourceStartSeq: 3,
        sourceEndSeq: 3,
        fragments: [
          { sourceStartSeq: 3, sourceEndSeq: 3, replacementText: "child summary must not render" },
        ],
      }),
    ],
  ]);

  const output = renderProjectionMessages({
    history: {
      sessionId: "ses_test",
      messages,
      marks: [],
      compressionMarkToolCalls: [],
    },
    messagePolicies: messages.map((message) =>
      createPolicy(message, message.sequence === 3 ? "protected" : "compressible"),
    ),
    markTree,
    resultGroupsByMarkId,
    failedToolMessageIds: new Map(),
    replacementGateOpen: false,
  });

  const renderedText = output.messages.map((message) => message.contentText).join("\n");
  assert.match(renderedText, /parent summary before gap/);
  assert.match(renderedText, /keep this user instruction/);
  assert.match(renderedText, /parent summary after gap/);
  assert.doesNotMatch(renderedText, /child summary must not render/);
});
