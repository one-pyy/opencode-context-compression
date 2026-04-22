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
      sessionId: fixture.sessionID,
    });
    assert.equal(beforeReplacement.reminders.length, 1);
    assert.equal(beforeReplacement.messages[2]?.source, "reminder");
    assert.equal(beforeReplacement.messages[2]?.contentText, "Compress soon.");

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
      sessionId: fixture.sessionID,
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
