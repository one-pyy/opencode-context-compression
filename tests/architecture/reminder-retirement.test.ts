import assert from "node:assert/strict";
import test from "node:test";

import { buildStableVisibleId } from "../../src/identity/visible-sequence.js";
import { createConfiguredReminderService } from "../../src/projection/reminder-service.js";
import type { ProjectedPromptMessage, ProjectionState } from "../../src/projection/types.js";

function fixture(tokens: number) {
  const protectedId = buildStableVisibleId("protected", 1, "user");
  const compressibleId = buildStableVisibleId("compressible", 2, "assistant");
  const messages: readonly ProjectedPromptMessage[] = [
    { source: "canonical", role: "user", canonicalId: "user", visibleKind: "protected", visibleId: protectedId, contentText: "Keep this requirement." },
    { source: "canonical", role: "assistant", canonicalId: "assistant", visibleKind: "compressible", visibleId: compressibleId, contentText: "Uncompressed work." },
  ];
  const state: ProjectionState = {
    sessionId: "retirement-test",
    history: { sessionId: "retirement-test", messages: [], marks: [], compressionMarkToolCalls: [] },
    markTree: { marks: [], conflicts: [] },
    conflicts: [],
    visibleIdAllocations: [],
    resultGroups: [],
    failedToolMessageIds: new Map(),
    messagePolicies: [
      { canonicalId: "user", sequence: 1, role: "user", visibleKind: "protected", tokenCount: 0, visibleId: protectedId, visibleSeq: 1, visibleBase62: "1" },
      { canonicalId: "assistant", sequence: 2, role: "assistant", visibleKind: "compressible", tokenCount: tokens, visibleId: compressibleId, visibleSeq: 2, visibleBase62: "2" },
    ],
  };
  return { state, messages };
}

function service(allowDelete = true, hdelete = 60_000) {
  return createConfiguredReminderService({
    hsoft: 10,
    hhard: 20,
    softRepeatEveryTokens: 100,
    hardRepeatEveryTokens: 100,
    hdelete,
    allowDelete,
    retirePromptText: "Retire unused summaries; compact originals.",
    promptTextByKind: {
      "soft-compact": "Soft compact.",
      "soft-delete": "Soft compact.",
      "hard-compact": "Hard compact.",
      "hard-delete": "Hard compact.",
    },
  });
}

for (const [tokens, severity] of [[10, "soft"], [20, "hard"]] as const) {
  for (const del of [59_999, 60_000, 60_001]) {
    test(`${severity} reminder changes inspect only when del is strictly above 60000: ${del}`, () => {
      const reminders = service().compute({ ...fixture(tokens), deletableTokenCount: del });
      const reminder = reminders.find((item) => item.kind.startsWith(severity));
      assert.ok(reminder);
      assert.match(reminder.contentText, severity === "soft" ? /Soft compact/u : /Hard compact/u);
      assert.ok(reminder.inspectListing);
      const listing = JSON.parse(reminder.inspectListing);
      if (del > 60_000) {
        assert.match(reminder.contentText, /Retire unused summaries/u);
        assert.equal(listing.mode, "delete");
        assert.deepEqual(listing.entries.map((entry: { kind: string }) => entry.kind), ["user", "compressible"]);
        assert.equal(reminder.inspectInput?.mode, "delete");
      } else {
        assert.doesNotMatch(reminder.contentText, /Retire unused summaries/u);
        assert.ok(listing.sections);
        assert.equal(reminder.inspectInput?.mode, "compact");
      }
      assert.equal(reminder.inspectInput?.to, reminder.anchorVisibleId);
    });
  }
}

test("summary pressure alone does not create a reminder", () => {
  assert.deepEqual(service().compute({ ...fixture(9), deletableTokenCount: 1_000_000 }), []);
});

test("disabled delete capability preserves compact reminders", () => {
  const reminders = service(false).compute({ ...fixture(10), deletableTokenCount: 60_001 });
  assert.equal(reminders[0]?.kind, "soft-compact");
  assert.equal(reminders[0]?.contentText, "Soft compact.");
  assert.equal(reminders[0]?.inspectInput?.mode, "compact");
});

test("hdelete is independent of soft/hard thresholds and reminders replay deterministically", () => {
  const input = { ...fixture(20), deletableTokenCount: 6 };
  const reminderService = service(true, 5);
  assert.deepEqual(reminderService.compute(input), reminderService.compute(input));
  assert.ok(reminderService.compute(input).every((item) => item.contentText.includes("Retire unused summaries")));
});
