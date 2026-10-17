import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import {
  createCanonicalIdentityService,
} from "../../../src/identity/canonical-identity.js";
import {
  createHistoryReplayReaderFromSources,
  type CanonicalHostMessage,
} from "../../../src/history/history-replay-reader.js";
import { createFlatPolicyEngine } from "../../../src/projection/policy-engine.js";
import { createProjectionBuilder } from "../../../src/projection/projection-builder.js";
import { createConfiguredReminderService } from "../../../src/projection/reminder-service.js";
import { resolveSessionDatabasePath, resolvePluginStateDirectory } from "../../../src/runtime/sidecar-layout.js";
import { createResultGroupRepository } from "../../../src/state/result-group-repository.js";
import {
  bootstrapSessionSidecar,
  openSessionSidecarRepository,
} from "../../../src/state/sidecar-store.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";
import { computeCompressionStats } from "../../../src/runtime/compression-stats.js";
import { projectProjectionToEnvelopes } from "../../../src/runtime/messages-transform.js";

for (const mode of ["compact", "delete"] as const) {
  test(`reminder and panel consume only applied ${mode} projection summaries`, { concurrency: false }, async (t) => {
    const fixture = await createHermeticE2EFixture(t, { suite: "interfaces", caseName: `retirement-${mode}` });
    const databasePath = resolveSessionDatabasePath(resolvePluginStateDirectory(fixture.repoRoot), fixture.sessionID);
    await bootstrapSessionSidecar({ databasePath });
    const sidecar = await openSessionSidecarRepository({ databasePath });
    t.after(() => sidecar.close());
    const resultGroups = createResultGroupRepository(sidecar);
    const identity = createCanonicalIdentityService({ visibleIds: resultGroups });
    await identity.allocateVisibleId("system", "protected");
    const first = await identity.allocateVisibleId("old-first", "compressible");
    const last = await identity.allocateVisibleId("old-last", "compressible");
    const current = await identity.allocateVisibleId("current", "compressible");
    const hostHistory = [
      hostEntry(1, createMessage("system", "system", "System.")),
      hostEntry(2, createMessage("old-first", "assistant", "Old investigation.")),
      hostEntry(3, createMessage("old-last", "tool", "Old evidence.")),
      hostEntry(4, createMessage("current", "assistant", "Current uncompressed work.")),
    ];
    const builder = createProjectionBuilder({
      historyReplayReader: createHistoryReplayReaderFromSources({
        sessionId: fixture.sessionID,
        hostHistory,
        toolHistory: [
          { sequence: 5, sourceMessageId: "mark-tool", toolName: "compression_mark", input: { mode, from: first.assignedVisibleId, to: last.assignedVisibleId }, result: { ok: true, markId: "old" } },
          { sequence: 6, sourceMessageId: "inspect-tool", toolName: "compression_inspect", input: { mode: "delete", to: current.assignedVisibleId, mergeAdjacent: true }, result: { ok: true, inspectId: "inspect-current" } },
        ],
      }),
      policyEngine: createFlatPolicyEngine({ smallUserMessageThreshold: 5 }),
      resultGroupRepository: resultGroups,
      canonicalIdentityService: identity,
      reminderService: createConfiguredReminderService({
        hsoft: 1, hhard: 10_000, hdelete: 1,
        softRepeatEveryTokens: 10_000, hardRepeatEveryTokens: 10_000,
        allowDelete: true, retirePromptText: "Retire unused summaries.",
        promptTextByKind: { "soft-compact": "Compact originals.", "soft-delete": "Compact originals.", "hard-compact": "Compact originals.", "hard-delete": "Compact originals." },
      }),
    });
    await resultGroups.upsertCompleteGroup({
      markId: "old", mode, executionMode: mode, sourceStartSeq: 2, sourceEndSeq: 3,
      createdAt: "2026-10-06T00:00:00.000Z", committedAt: "2026-10-06T00:00:00.000Z",
      fragments: [{ sourceStartSeq: 2, sourceEndSeq: 3, replacementText: "Summary of completed work and its verified evidence." }],
    });
    const pending = await builder.build({ sessionId: fixture.sessionID, replacementGateOpen: false });
    assert.equal(pending.deletableTokenCount, 0);
    assert.ok(pending.reminders.every((item) => !item.contentText.includes("Retire unused")));

    const applied = await builder.build({ sessionId: fixture.sessionID, replacementGateOpen: true });
    assert.equal(applied.reminders.length, 1);
    assert.equal(applied.reminders[0]?.anchorVisibleId, current.assignedVisibleId);
    const listing = applied.reminders[0]?.inspectListing;
    assert.ok(listing);
    const rows = listing.split("\n").slice(3).map((line) => line.split("\t"));
    if (mode === "compact") {
      assert.ok((applied.deletableTokenCount ?? 0) > 1);
      assert.match(applied.reminders[0]?.contentText ?? "", /Retire unused summaries/u);
      assert.ok(listing.startsWith("模式\tdelete\n"));
      assert.equal(rows[0]?.[0], "referable");
      assert.equal(Number(rows[0]?.[3]), applied.deletableTokenCount);
      assert.equal(Number(listing.split("\n")[1]?.split("\t")[1]), rows.reduce((total, row) => total + Number(row[3]), 0));
      assert.equal(rows.at(-1)?.[0], "compressible");
      const actualInspect = applied.toolResultOverrides.find((override) => override.sourceMessageId === "inspect-tool");
      assert.ok(actualInspect);
      assert.equal(actualInspect.output, listing);
    } else {
      assert.equal(applied.deletableTokenCount, 0);
      assert.ok(listing.startsWith("模式\tcompact\n"));
    }
    const inspectPair = projectProjectionToEnvelopes(applied).flatMap((item) => item.parts)
      .find((part) => part.type === "tool" && part.tool === "compression_inspect");
    assert.ok(inspectPair && inspectPair.type === "tool" && inspectPair.state.status === "completed");
    assert.deepEqual(inspectPair.state.input, { mode: mode === "compact" ? "delete" : "compact", to: current.assignedVisibleId });
    const stats = await computeCompressionStats(applied, "t", async (text) => {
      assert.ok(mode !== "compact" || !text.includes("Summary of completed"), "panel must reuse the precomputed summary count");
      return 1;
    });
    assert.equal(stats.deletableTokenCount, applied.deletableTokenCount);
  });
}

test(
  "reminders stay projection-only and disappear once a covered window is successfully replaced",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "reminder artifact behavior",
    });
    const stateDirectory = resolvePluginStateDirectory(fixture.repoRoot);
    const databasePath = resolveSessionDatabasePath(stateDirectory, fixture.sessionID);
    await rm(databasePath, { force: true });
    await bootstrapSessionSidecar({ databasePath });

    const sidecar = await openSessionSidecarRepository({ databasePath });
    t.after(() => sidecar.close());

    const resultGroups = createResultGroupRepository(sidecar);
    const identity = createCanonicalIdentityService({
      visibleIds: resultGroups,
      allocateAt: () => "2026-04-06T10:00:00.000Z",
    });

    const hostHistory = [
      hostEntry(1, createMessage("msg-system-1", "system", "System guidance.")),
      hostEntry(2, createMessage("msg-assistant-1", "assistant", "I can help with that.")),
      hostEntry(3, createMessage("msg-tool-1", "tool", "Search results arrive here.")),
    ] as const;
    const originalMessageIds = hostHistory.map((entry) => entry.message.info.id);

    await identity.allocateVisibleId("msg-system-1", "protected");
    const assistantVisibleId = await identity.allocateVisibleId("msg-assistant-1", "compressible");
    const toolVisibleId = await identity.allocateVisibleId("msg-tool-1", "compressible");

    const historyReplayReader = createHistoryReplayReaderFromSources({
      sessionId: fixture.sessionID,
      hostHistory,
      toolHistory: [
        {
          sequence: 4,
          sourceMessageId: "tool-mark-window",
          toolName: "compression_mark",
          input: {
            mode: "compact",
            from: assistantVisibleId.assignedVisibleId,
            to: toolVisibleId.assignedVisibleId,
          },
          result: {
            ok: true,
            markId: "mark-window",
          },
        },
      ],
    });

    const projectionBuilder = createProjectionBuilder({
      historyReplayReader,
      policyEngine: createFlatPolicyEngine({
        smallUserMessageThreshold: 5,
      }),
      resultGroupRepository: resultGroups,
      canonicalIdentityService: identity,
      reminderService: createConfiguredReminderService({
        hsoft: 1,
        hhard: 10_000,
        softRepeatEveryTokens: 10_000,
        hardRepeatEveryTokens: 10_000,
        allowDelete: false,
        promptTextByKind: {
          "soft-compact": "Compress soon.",
          "soft-delete": "Delete when safe.",
          "hard-compact": "Compact now.",
          "hard-delete": "Delete now.",
        },
      }),
    });

    const beforeReplacement = await projectionBuilder.build({
      sessionId: fixture.sessionID, replacementGateOpen: true,
    });
    assert.equal(beforeReplacement.reminders.length, 1);
    assert.equal(beforeReplacement.messages[2]?.source, "reminder");
    assert.equal(beforeReplacement.messages[2]?.role, "assistant");
    assert.equal(beforeReplacement.messages[2]?.contentText, "Compress soon.");
    assert.equal(
      beforeReplacement.messages[2]?.reminderToolName,
      "opencode_context_compression_notice",
    );

    await resultGroups.upsertCompleteGroup({
      markId: "mark-window",
      mode: "compact",
      sourceStartSeq: 2,
      sourceEndSeq: 3,
      executionMode: "compact",
      createdAt: "2026-04-06T10:05:00.000Z",
      committedAt: "2026-04-06T10:05:30.000Z",
      fragments: [
        {
          sourceStartSeq: 2,
          sourceEndSeq: 3,
          replacementText: "Compacted block.",
        },
      ],
    });

    const afterReplacement = await projectionBuilder.build({
      sessionId: fixture.sessionID, replacementGateOpen: true,
    });
    assert.equal(afterReplacement.reminders.length, 0);
    assert.deepEqual(
      afterReplacement.messages.map((message) => message.source),
      ["canonical", "result-group"],
    );
    assert.deepEqual(hostHistory.map((entry) => entry.message.info.id), originalMessageIds);
    assert.equal(sidecar.listVisibleIDs().length, hostHistory.length);
    assert.equal(sidecar.listResultGroups().length, 1);

    const evidencePath = await fixture.evidence.writeJson(
      "reminder-artifact-behavior",
      {
        beforeReplacement: beforeReplacement.messages,
        afterReplacement: afterReplacement.messages,
        durableVisibleIdCount: sidecar.listVisibleIDs().length,
        durableResultGroupCount: sidecar.listResultGroups().length,
      },
    );
    assert.match(evidencePath, /reminder-artifact-behavior\.json$/u);
  },
);

test("applying summaries after an early reminder preserves its materialized request prefix", async (t) => {
  const repoRoot = await mkdtemp("/tmp/opencode/compression-prefix-");
  const fixture = await createHermeticE2EFixture(t, { suite: "interfaces", caseName: `prefix-summary-growth-${repoRoot.split("/").at(-1)}`, repoRoot });
  t.mock.method(globalThis, "fetch", async (_request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    return Response.json({ tokens: Math.ceil(text.length / 4) });
  });
  const databasePath = resolveSessionDatabasePath(resolvePluginStateDirectory(repoRoot), fixture.sessionID);
  await bootstrapSessionSidecar({ databasePath });
  const sidecar = await openSessionSidecarRepository({ databasePath });
  t.after(() => sidecar.close());
  const resultGroups = createResultGroupRepository(sidecar);
  const identity = createCanonicalIdentityService({ visibleIds: resultGroups });
  const texts = ["System.", "First old work.", "First old evidence.", "Early work.", "Later old work.", "Later old evidence.", "Late work with additional uncompressed evidence."];
  const hostHistory = texts.map((text, index) => hostEntry(index + 1, createMessage(`prefix-${index}`, index === 0 ? "system" : "assistant", text)));
  const ids = await Promise.all(hostHistory.map((entry) => identity.allocateVisibleId(entry.message.info.id, entry.message.info.role === "system" ? "protected" : "compressible")));
  const builder = createProjectionBuilder({
    historyReplayReader: createHistoryReplayReaderFromSources({ sessionId: fixture.sessionID, hostHistory, toolHistory: [
      { sequence: 8, sourceMessageId: "prefix-mark-1", toolName: "compression_mark", input: { mode: "compact", from: ids[1]!.assignedVisibleId, to: ids[2]!.assignedVisibleId }, result: { ok: true, markId: "prefix-first" } },
      { sequence: 9, sourceMessageId: "prefix-mark-2", toolName: "compression_mark", input: { mode: "compact", from: ids[4]!.assignedVisibleId, to: ids[5]!.assignedVisibleId }, result: { ok: true, markId: "prefix-later" } },
    ] }),
    policyEngine: createFlatPolicyEngine(), resultGroupRepository: resultGroups, canonicalIdentityService: identity,
    reminderService: createConfiguredReminderService({ hsoft: 1, hhard: 5, hdelete: 60_000, softRepeatEveryTokens: 100_000, hardRepeatEveryTokens: 100_000, allowDelete: true, retirePromptText: "Retire summaries.", promptTextByKind: { "soft-compact": "Compact.", "soft-delete": "Compact.", "hard-compact": "Compact.", "hard-delete": "Compact." } }),
  });
  await resultGroups.upsertCompleteGroup({ markId: "prefix-first", mode: "compact", executionMode: "compact", sourceStartSeq: 2, sourceEndSeq: 3, createdAt: "t", committedAt: "t", fragments: [{ sourceStartSeq: 2, sourceEndSeq: 3, replacementText: "A".repeat(239_000) }] });
  const before = await builder.build({ sessionId: fixture.sessionID, replacementGateOpen: true });
  assert.ok(before.deletableTokenCount! < 60_000, `summary tokens=${before.deletableTokenCount}; visible lengths=${before.messages.filter((message) => message.source === "result-group").map((message) => message.contentText.length)}`);
  const beforeMessages = projectProjectionToEnvelopes(before);
  const firstInspect = beforeMessages.findIndex((message) => message.parts.some((part) => part.type === "tool" && part.tool === "compression_inspect"));
  assert.ok(firstInspect > 0);
  const prefix = beforeMessages.slice(0, firstInspect + 1);
  await resultGroups.upsertCompleteGroup({ markId: "prefix-later", mode: "compact", executionMode: "compact", sourceStartSeq: 5, sourceEndSeq: 6, createdAt: "t", committedAt: "t", fragments: [{ sourceStartSeq: 5, sourceEndSeq: 6, replacementText: "B".repeat(4_000) }] });
  const after = await builder.build({ sessionId: fixture.sessionID, replacementGateOpen: true });
  assert.ok(after.deletableTokenCount! > 60_000);
  assert.deepEqual(projectProjectionToEnvelopes(after).slice(0, prefix.length), prefix);
  assert.equal(after.reminders.find((item) => item.anchorCanonicalId === "prefix-3")?.inspectInput?.mode, "compact");
  assert.equal(after.reminders.find((item) => item.anchorCanonicalId === "prefix-6")?.inspectInput?.mode, "delete");
});

function hostEntry(sequence: number, message: CanonicalHostMessage) {
  return {
    sequence,
    message,
  };
}

function createMessage(
  id: string,
  role: "system" | "user" | "assistant" | "tool",
  text: string,
): CanonicalHostMessage {
  return {
    info: {
      id,
      role,
    },
    parts: [
      {
        type: "text",
        text,
      },
    ],
  };
}
