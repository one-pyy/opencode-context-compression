import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMessagesTransformHook, createProjectionBackedMessagesTransformProjector } from "../../src/runtime/messages-transform.js";
import type { ProjectedMessageSet } from "../../src/projection/types.js";

test("Messages Transform Hook - In-place Mutation Contract (12.5)", async () => {
  const dummyProjection: ProjectedMessageSet = {
    sessionId: "ses_1",
    messages: [
      {
        source: "result-group",
        role: "assistant",
        canonicalId: "m1",
        visibleKind: "compressible",
        visibleId: "compressible_000001_abc",
        contentText: "Replaced Content"
      }
    ],
    toolResultOverrides: [],
    reminders: [],
    conflicts: [],
    state: {
      messagePolicies: [],
      resultGroups: [],
      history: {
        messages: [],
        marks: [],
        compressionMarkToolCalls: []
      },
      markTree: { marks: [], conflicts: [] }
    } as any
  };

  const projector = createProjectionBackedMessagesTransformProjector({
    buildProjection: () => dummyProjection
  });

  const hook = createMessagesTransformHook({ projector });

  const originalMessagesArray: any[] = [
    { info: { id: "old1" }, parts: [] },
    { info: { id: "old2" }, parts: [] }
  ];

  const outputObject = {
    messages: originalMessagesArray
  };

  // Execute hook
  await hook({} as any, outputObject as any);

  // 1. The array reference MUST remain exactly the same
  assert.strictEqual(
    outputObject.messages, 
    originalMessagesArray, 
    "Implementation violates 12.5: Must mutate the output.messages array in place, not reassign it."
  );

  // 2. The contents of the array MUST be replaced by the projection
  assert.equal(outputObject.messages.length, 1);
  assert.equal(outputObject.messages[0].parts[0].text, "Replaced Content");
  
  // 3. The IDs and metadata should be correctly mapped
  assert.equal(outputObject.messages[0].info.id, "m1");
  assert.equal(outputObject.messages[0].info.role, "assistant");
});

test("Messages Transform debug counts only projected compressible tokens", async () => {
  const projection: ProjectedMessageSet = {
    sessionId: "ses_1",
    messages: [
      {
        source: "result-group",
        role: "assistant",
        sourceMarkId: "mark-old",
        visibleKind: "referable",
        visibleId: "referable_000001_abc",
        contentText: "Compressed old prefix",
      },
      {
        source: "canonical",
        role: "assistant",
        canonicalId: "msg-new-openai-response",
        visibleKind: "compressible",
        visibleId: "compressible_000002_def",
        contentText: "Fresh large response",
      },
    ],
    toolResultOverrides: [],
    reminders: [{
      kind: "hard-compact",
      anchorCanonicalId: "msg-new-openai-response",
      anchorVisibleId: "compressible_000002_def",
      visibleId: "reminder_000002_xyz",
      contentText: "Hard reminder.",
    }],
    conflicts: [],
    state: {
      messagePolicies: [
        {
          canonicalId: "msg-hidden-old-prefix",
          sequence: 1,
          role: "assistant",
          visibleKind: "compressible",
          tokenCount: 80_000,
          visibleId: "compressible_000001_old",
          visibleSeq: 1,
          visibleBase62: "old",
        },
        {
          canonicalId: "msg-new-openai-response",
          sequence: 2,
          role: "assistant",
          visibleKind: "compressible",
          tokenCount: 100_000,
          visibleId: "compressible_000002_def",
          visibleSeq: 2,
          visibleBase62: "def",
        },
      ],
      resultGroups: [],
      history: {
        messages: [],
        marks: [],
        compressionMarkToolCalls: [],
      },
      markTree: { marks: [], conflicts: [] },
      conflicts: [],
      visibleIdAllocations: [],
      failedToolMessageIds: new Map(),
    },
  } as ProjectedMessageSet;

  const projector = createProjectionBackedMessagesTransformProjector({
    buildProjection: () => projection,
  });

  const input = { sessionID: "ses_1" } as Parameters<
    typeof projector.project
  >[0]["input"];
  await projector.project({ input, currentMessages: [] });

  assert.equal(
    projector.getLastProjectionDebugState()?.totalCompressibleTokenCount,
    100_000,
  );
});
