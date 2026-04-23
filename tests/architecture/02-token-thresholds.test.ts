import { strict as assert } from "node:assert";
import { test } from "node:test";
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
    resultGroups: [], failedToolMessageIds: new Set() };
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
  // It should trigger: soft 1 (30k), soft 2 (50k), hard 1 (70k), hard 2 (80k)
  assert.equal(reminders.length, 4);
  assert.equal(reminders[0].kind, "soft-delete");
  assert.equal(reminders[1].kind, "soft-delete");
  assert.equal(reminders[2].kind, "hard-delete");
  assert.equal(reminders[3].kind, "hard-delete");
  assert.equal(reminders.every(r => r.anchorCanonicalId === "msg_1"), true);
});

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
