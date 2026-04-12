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
