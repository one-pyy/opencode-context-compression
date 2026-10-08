import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
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
    const listing = JSON.parse(applied.reminders[0]?.inspectListing ?? "{}");
    if (mode === "compact") {
      assert.ok((applied.deletableTokenCount ?? 0) > 1);
      assert.match(applied.reminders[0]?.contentText ?? "", /Retire unused summaries/u);
      assert.equal(listing.mode, "delete");
      assert.equal(listing.entries[0]?.kind, "fragment");
      assert.equal(listing.entries[0]?.tokens, applied.deletableTokenCount);
      assert.equal(listing.totalTokens, listing.entries.reduce((total: number, entry: { tokens: number }) => total + entry.tokens, 0));
      assert.equal(listing.entries.at(-1)?.kind, "compressible");
      const actualInspect = applied.toolResultOverrides.find((override) => override.sourceMessageId === "inspect-tool");
      assert.ok(actualInspect);
      assert.deepEqual(JSON.parse(actualInspect.output), listing);
    } else {
      assert.equal(applied.deletableTokenCount, 0);
      assert.ok(listing.sections);
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
