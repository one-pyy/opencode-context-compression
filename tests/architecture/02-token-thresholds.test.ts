import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildStableVisibleId } from "../../src/identity/visible-sequence.js";
import { createConfiguredReminderService } from "../../src/projection/reminder-service.js";
import type { ProjectedPromptMessage, ProjectionState } from "../../src/projection/types.js";

function createProjectedMsg(id: string, tokenCount: number, visibleKind: "compressible" | "protected"): ProjectedPromptMessage {
  return {
    source: "canonical",
    role: "user",
    canonicalId: id,
    visibleKind,
    visibleId: `vis_${id}`,
    contentText: "..."
  };
}

function createState(messages: { id: string; tokenCount: number; visibleKind: any }[]): ProjectionState {
  const messagePolicies = messages.map(m => ({
    canonicalId: m.id,
    sequence: 1,
    role: "user" as const,
    visibleKind: m.visibleKind,
    tokenCount: m.tokenCount,
    visibleId: `vis_${m.id}`,
    visibleSeq: 1,
    visibleBase62: "abc"
  }));
  return {
    sessionId: "ses_1",
    history: { sessionId: "ses_1", messages: [], marks: [], compressionMarkToolCalls: [] },
    markTree: { marks: [], conflicts: [] },
    conflicts: [],
    messagePolicies,
    visibleIdAllocations: [],
    resultGroups: [], failedToolMessageIds: new Map() };
}

const promptTextByKind = {
  "soft-compact": "SOFT_COMPACT",
  "soft-delete": "SOFT_DELETE",
  "hard-compact": "HARD_COMPACT",
  "hard-delete": "HARD_DELETE"
};

test("Reminder Cadence - Under Threshold", () => {
  const service = createConfiguredReminderService({
    hsoft: 30000, hhard: 70000, softRepeatEveryTokens: 20000, hardRepeatEveryTokens: 10000, allowDelete: false, promptTextByKind
  });

  const msgs = [createProjectedMsg("msg_1", 29999, "compressible")];
  const state = createState([{ id: "msg_1", tokenCount: 29999, visibleKind: "compressible" }]);
  
  const reminders = service.compute({ state, messages: msgs });
  assert.equal(reminders.length, 0);
});

test("Reminder Cadence - Soft Threshold Triggered", () => {
  const service = createConfiguredReminderService({
    hsoft: 30000, hhard: 70000, softRepeatEveryTokens: 20000, hardRepeatEveryTokens: 10000, allowDelete: false, promptTextByKind
  });

  const msgs = [
    createProjectedMsg("msg_1", 20000, "compressible"),
    createProjectedMsg("msg_2", 15000, "compressible") // total 35000 -> soft reminder
  ];
  const state = createState([
    { id: "msg_1", tokenCount: 20000, visibleKind: "compressible" },
    { id: "msg_2", tokenCount: 15000, visibleKind: "compressible" }
  ]);
  
  const reminders = service.compute({ state, messages: msgs });
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].kind, "soft-compact");
  assert.equal(reminders[0].anchorCanonicalId, "msg_2");
});

test("Reminder Cadence - Soft Repeated", () => {
  const service = createConfiguredReminderService({
    hsoft: 30000, hhard: 70000, softRepeatEveryTokens: 20000, hardRepeatEveryTokens: 10000, allowDelete: false, promptTextByKind
  });

  const msgs = [
    createProjectedMsg("msg_1", 30000, "compressible"), // triggers first soft
    createProjectedMsg("msg_2", 20000, "compressible")  // triggers second soft
  ];
  const state = createState([
    { id: "msg_1", tokenCount: 30000, visibleKind: "compressible" },
    { id: "msg_2", tokenCount: 20000, visibleKind: "compressible" }
  ]);
  
  const reminders = service.compute({ state, messages: msgs });
  assert.equal(reminders.length, 2);
  assert.equal(reminders[0].anchorCanonicalId, "msg_1");
  assert.equal(reminders[1].anchorCanonicalId, "msg_2");
});

test("Reminder Cadence - Hard Replaces Soft and allowDelete alters text", () => {
  const service = createConfiguredReminderService({
    hsoft: 30000, hhard: 70000, softRepeatEveryTokens: 20000, hardRepeatEveryTokens: 10000, allowDelete: true, promptTextByKind
  });

  const msgs = [
    createProjectedMsg("msg_1", 80000, "compressible") // > hhard
  ];
  const state = createState([
    { id: "msg_1", tokenCount: 80000, visibleKind: "compressible" }
  ]);
  
  const reminders = service.compute({ state, messages: msgs });
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].kind, "hard-delete");
  assert.equal(reminders.every(r => r.anchorCanonicalId === "msg_1"), true);
});

for (const [jumpTokens, winningMilestone, nextMilestone, kind] of [
  [110000, 100000, 120000, "soft-compact"],
  [120000, 120000, 140000, "hard-compact"],
  [188217, 180000, 200000, "hard-compact"],
] as const) {
  test(`Reminder Cadence - ${jumpTokens} tokens keeps only the highest milestone without catch-up`, () => {
    const service = createConfiguredReminderService({
      hsoft: 60000, hhard: 120000, softRepeatEveryTokens: 40000, hardRepeatEveryTokens: 20000, allowDelete: false, promptTextByKind
    });
    const entries = [
      { id: "jump", tokenCount: jumpTokens, visibleKind: "compressible" as const },
      { id: "below-next", tokenCount: nextMilestone - jumpTokens - 1, visibleKind: "compressible" as const },
      { id: "next", tokenCount: 1, visibleKind: "compressible" as const },
    ];
    const state = createState(entries);
    const messagePolicies = state.messagePolicies.map((policy, index) => ({
      ...policy,
      sequence: index + 1,
      visibleSeq: index + 1,
      visibleId: buildStableVisibleId("compressible", index + 1, policy.canonicalId),
    }));
    const input = {
      state: { ...state, messagePolicies },
      messages: entries.map((entry, index) => ({
        ...createProjectedMsg(entry.id, entry.tokenCount, entry.visibleKind),
        visibleId: messagePolicies[index].visibleId,
      })),
    };
    const reminders = service.compute(input);
    assert.deepEqual(reminders.map(reminder => [reminder.anchorCanonicalId, reminder.kind]), [
      ["jump", kind], ["next", "hard-compact"],
    ]);
    const exact = service.compute({
      state: { ...input.state, messagePolicies: [{ ...messagePolicies[0], tokenCount: winningMilestone }] },
      messages: [input.messages[0]],
    });
    assert.equal(reminders[0].visibleId, exact[0].visibleId);
    assert.ok(reminders[0].inspectListing);
    assert.deepEqual(reminders[0].inspectInput, { mode: "compact", to: input.messages[0].visibleId });
    assert.deepEqual(service.compute(input), reminders);
  });
}

test("Reminder Cadence - Protected Messages Are Ignored", () => {
  const service = createConfiguredReminderService({
    hsoft: 30000, hhard: 70000, softRepeatEveryTokens: 20000, hardRepeatEveryTokens: 10000, allowDelete: false, promptTextByKind
  });

  const msgs = [
    createProjectedMsg("msg_1", 50000, "protected") // protected, shouldn't count
  ];
  const state = createState([
    { id: "msg_1", tokenCount: 50000, visibleKind: "protected" }
  ]);
  
  const reminders = service.compute({ state, messages: msgs });
  assert.equal(reminders.length, 0);
});

for (const allowDelete of [false, true]) {
  test(`hard guidance fills prefix token counts and coverage target: allowDelete=${allowDelete}`, () => {
    const service = createConfiguredReminderService({
      hsoft: 40000, hhard: 150000, softRepeatEveryTokens: 20000, hardRepeatEveryTokens: 10000, allowDelete, promptTextByKind,
    });
    const entries = [
      { id: "first", tokenCount: 150002, visibleKind: "compressible" as const },
      { id: "protected", tokenCount: 90000, visibleKind: "protected" as const },
      { id: "later", tokenCount: 20000, visibleKind: "compressible" as const },
    ];
    const state = createState(entries);
    const messages = entries.map((entry) => createProjectedMsg(entry.id, entry.tokenCount, entry.visibleKind));
    const initial = service.compute({ state: { ...state, messagePolicies: state.messagePolicies.slice(0, 1) }, messages: messages.slice(0, 1) });
    const after = service.compute({ state, messages });
    assert.deepEqual(after[0], initial[0]);
    assert.ok(after[0].contentText.includes("当前可压缩原文共 150002 词元，建议本轮标记覆盖超过 100001 词元"));
    assert.ok(after[1].contentText.includes("当前可压缩原文共 170002 词元，建议本轮标记覆盖超过 113334 词元"));
    assert.doesNotMatch(after[0].contentText, /2\/3/u);
  });
}

test("soft reminder text does not gain hard coverage guidance", () => {
  const service = createConfiguredReminderService({
    hsoft: 30000, hhard: 70000, softRepeatEveryTokens: 20000, hardRepeatEveryTokens: 10000, allowDelete: false, promptTextByKind,
  });
  const state = createState([{ id: "soft", tokenCount: 30000, visibleKind: "compressible" }]);
  const reminders = service.compute({ state, messages: [createProjectedMsg("soft", 30000, "compressible")] });
  assert.equal(reminders[0].contentText, "SOFT_COMPACT");
});
