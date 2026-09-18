import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlatPolicyEngine } from "../../src/projection/policy-engine.js";
import type { ReplayedHistory, ReplayedMarkIntent } from "../../src/history/history-replay-reader.js";
import type { CompleteResultGroup } from "../../src/state/result-group-repository.js";

function createResultGroup(markId: string, start: number, end: number, mode: "compact" | "delete"): CompleteResultGroup {
  return {
    markId, mode, sourceStartSeq: start, sourceEndSeq: end,
    fragmentCount: 1, executionMode: mode, createdAt: "2026-09-18T00:00:00.000Z",
    payloadSha256: "fixture", applied: true,
    fragments: [{ fragmentIndex: 0, sourceStartSeq: start, sourceEndSeq: end, replacementText: "summary" }],
  };
}

function retiredRangeFixture(mode: "compact" | "delete" = "compact") {
  const messages: ReplayedHistory["messages"] = Array.from({ length: 8 }, (_, i) => ({
    sequence: i + 1, canonicalId: `msg_${i + 1}`, role: "assistant", contentText: "body",
    parts: [{ type: "text", text: "body" }],
    hostMessage: { info: { id: `msg_${i + 1}`, role: "assistant" }, parts: [{ type: "text", text: "body" }] },
  }));
  const visibleIdsByCanonicalId = new Map(messages.map((message) => [
    message.canonicalId, `compressible_${String(message.sequence).padStart(6, "0")}_aa`,
  ]));
  const mark = (markId: string, start: number, end: number, sourceSequence: number): ReplayedMarkIntent => ({
    markId, mode: "compact", sourceSequence, sourceMessageId: `call-${markId}`,
    startVisibleMessageId: visibleIdsByCanonicalId.get(`msg_${start}`)!,
    endVisibleMessageId: visibleIdsByCanonicalId.get(`msg_${end}`)!,
  });
  const history: ReplayedHistory = {
    sessionId: "retired-range", messages, compressionMarkToolCalls: [],
    marks: [
      { ...mark("retired", 2, 3, 9), mode: "delete" },
      { ...mark("invalid", 1, 5, 10), mode },
      mark("legal-child", 4, 4, 11),
      mark("legal-later", 4, 6, 12),
    ],
  };
  return {
    history, visibleIdsByCanonicalId, mark,
    resultGroups: [createResultGroup("retired", 2, 3, "delete")],
  };
}

function buildTree(input: ReturnType<typeof retiredRangeFixture>) {
  return createFlatPolicyEngine().buildMarkTree(input);
}

for (const mode of ["compact", "delete"] as const) {
  test(`Policy Engine - ${mode} cannot contain delete marks or block later legal marks`, () => {
    const tree = buildTree(retiredRangeFixture(mode));
    assert.deepEqual(tree.conflicts.map((conflict) => conflict.markId), ["invalid"]);
    assert.match(tree.conflicts[0].message, /contains delete mark/);
    assert.deepEqual(tree.marks.map((mark) => mark.markId), ["retired", "legal-later"]);
    assert.equal(tree.marks[1].children[0].markId, "legal-child");
    assert.equal(tree.marks[1].children[0].depth, 1);
  });
}

test("Policy Engine - delete containment conflicts do not depend on result existence or application", () => {
  const fixture = retiredRangeFixture();
  const expected = buildTree({ ...fixture, resultGroups: [] });
  const completedParent = createResultGroup("invalid", 1, 5, "compact");
  for (const applied of [false, true]) {
    const resultGroups = [...fixture.resultGroups, completedParent].map((group) => ({ ...group, applied }));
    assert.deepEqual(buildTree({ ...fixture, resultGroups }), expected);
  }
});

test("Policy Engine - a later delete inside an earlier compact is rejected", () => {
  const fixture = retiredRangeFixture();
  const tree = buildTree({
    ...fixture,
    history: { ...fixture.history, marks: [fixture.mark("older-parent", 1, 5, 8), fixture.history.marks[0]] },
  });
  assert.deepEqual(tree.conflicts.map((conflict) => conflict.markId), ["retired"]);
  assert.deepEqual(tree.marks.map((mark) => mark.markId), ["older-parent"]);
  assert.equal(tree.marks[0].children.length, 0);
});

for (const earlierMode of ["compact", "delete"] as const) {
  for (const laterMode of ["compact", "delete"] as const) {
    for (const relation of ["inside", "contains", "equal"] as const) {
      test(`Policy Engine - ${laterMode} ${relation} earlier ${earlierMode}`, () => {
        const fixture = retiredRangeFixture();
        const earlierRange = relation === "inside" ? [1, 5] : [2, 3];
        const laterRange = relation === "contains" ? [1, 5] : [2, 3];
        const earlier = { ...fixture.mark("earlier", earlierRange[0], earlierRange[1], 9), mode: earlierMode };
        const later = { ...fixture.mark("later", laterRange[0], laterRange[1], 10), mode: laterMode };
        const tree = buildTree({
          ...fixture, resultGroups: [], history: { ...fixture.history, marks: [later, earlier] },
        });
        const rejected = relation === "inside" ? laterMode === "delete" : earlierMode === "delete";
        if (rejected) {
          assert.deepEqual(tree.conflicts.map((conflict) => conflict.markId), ["later"]);
          assert.equal(tree.marks[0].markId, "earlier");
          assert.equal(tree.marks[0].children.length, 0);
        } else {
          assert.equal(tree.conflicts.length, 0);
          const parentId = relation === "inside" ? "earlier" : "later";
          assert.equal(tree.marks[0].markId, parentId);
          assert.equal(tree.marks[0].children[0].markId, parentId === "earlier" ? "later" : "earlier");
          assert.equal(tree.marks[0].children[0].mode, "compact");
        }
      });
    }
  }
}

test("Policy Engine - rejection does not adopt a compact sibling before encountering a delete sibling", () => {
  const fixture = retiredRangeFixture();
  const tree = buildTree({
    ...fixture, resultGroups: [],
    history: { ...fixture.history, marks: [
      fixture.mark("compact-first", 1, 1, 8),
      fixture.history.marks[0],
      fixture.mark("invalid", 1, 5, 10),
    ] },
  });
  assert.deepEqual(tree.conflicts.map((conflict) => conflict.markId), ["invalid"]);
  assert.deepEqual(tree.marks.map((mark) => mark.markId), ["compact-first", "retired"]);
  assert.ok(tree.marks.every((mark) => mark.children.length === 0));
});
