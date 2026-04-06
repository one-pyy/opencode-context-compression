import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
  createCanonicalIdentityService,
} from "../../../src/identity/canonical-identity.js";
import { buildStableVisibleId } from "../../../src/identity/visible-sequence.js";
import {
  createHistoryReplayReaderFromSources,
  type CanonicalHostMessage,
} from "../../../src/history/history-replay-reader.js";
import { createFlatPolicyEngine } from "../../../src/projection/policy-engine.js";
import { createProjectionBuilder } from "../../../src/projection/projection-builder.js";
import { createStaticReminderService } from "../../../src/projection/reminder-service.js";
import { resolveSessionDatabasePath, resolvePluginStateDirectory } from "../../../src/runtime/sidecar-layout.js";
import { createResultGroupRepository } from "../../../src/state/result-group-repository.js";
import {
  bootstrapSessionSidecar,
  openSessionSidecarRepository,
} from "../../../src/state/sidecar-store.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "projection replay uses legal mark nesting plus child-result and original-gap fallback",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "projection replay contract",
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
      allocateAt: () => "2026-04-06T08:00:00.000Z",
    });

    const hostHistory = [
      hostEntry(1, createMessage("msg-user-1", "user", "User one carries enough text for compression.")),
      hostEntry(2, createMessage("msg-assistant-1", "assistant", "Assistant body that may later collapse.")),
      hostEntry(3, createMessage("msg-tool-1", "tool", "Tool result body stays as the original gap.")),
      hostEntry(4, createMessage("msg-user-2", "user", "User two also stays visible after fallback.")),
    ] as const;

    const visibleIds = {
      user1: await identity.allocateVisibleId("msg-user-1", "compressible"),
      assistant1: await identity.allocateVisibleId("msg-assistant-1", "compressible"),
      tool1: await identity.allocateVisibleId("msg-tool-1", "compressible"),
      user2: await identity.allocateVisibleId("msg-user-2", "compressible"),
    };

    await resultGroups.upsertCompleteGroup({
      markId: "mark-child",
      mode: "compact",
      sourceStartSeq: 2,
      sourceEndSeq: 3,
      executionMode: "compact",
      createdAt: "2026-04-06T08:10:00.000Z",
      committedAt: "2026-04-06T08:10:30.000Z",
      fragments: [
        {
          sourceStartSeq: 2,
          sourceEndSeq: 2,
          replacementText: "Assistant summary.",
        },
      ],
    });

    const projectionBuilder = createProjectionBuilder({
      historyReplayReader: createHistoryReplayReaderFromSources({
        sessionId: fixture.sessionID,
        hostHistory,
        toolHistory: [
          {
            sequence: 5,
            sourceMessageId: "tool-mark-child",
            toolName: "compression_mark",
            input: {
              contractVersion: "v1",
              mode: "compact",
              target: {
                startVisibleMessageID: visibleIds.assistant1.assignedVisibleId,
                endVisibleMessageID: visibleIds.tool1.assignedVisibleId,
              },
            },
            result: {
              ok: true,
              markId: "mark-child",
            },
          },
          {
            sequence: 6,
            sourceMessageId: "tool-mark-parent",
            toolName: "compression_mark",
            input: {
              contractVersion: "v1",
              mode: "compact",
              target: {
                startVisibleMessageID: visibleIds.user1.assignedVisibleId,
                endVisibleMessageID: visibleIds.user2.assignedVisibleId,
              },
            },
            result: {
              ok: true,
              markId: "mark-parent",
            },
          },
        ],
      }),
      policyEngine: createFlatPolicyEngine({
        smallUserMessageThreshold: 5,
      }),
      resultGroupRepository: resultGroups,
      canonicalIdentityService: identity,
      reminderService: createStaticReminderService(),
    });

    const projection = await projectionBuilder.build({
      sessionId: fixture.sessionID,
    });

    assert.deepEqual(
      projection.state.markTree.marks.map((mark) => ({
        markId: mark.markId,
        children: mark.children.map((child) => child.markId),
      })),
      [
        {
          markId: "mark-parent",
          children: ["mark-child"],
        },
      ],
    );
    assert.equal(projection.conflicts.length, 0);
    assert.deepEqual(
      projection.messages.map((message) => message.contentText),
      [
        `[${visibleIds.user1.assignedVisibleId}] User one carries enough text for compression.`,
        `[${buildStableVisibleId("referable", 2, "mark-child:0")}] Assistant summary.`,
        `[${visibleIds.tool1.assignedVisibleId}] Tool result body stays as the original gap.`,
        `[${visibleIds.user2.assignedVisibleId}] User two also stays visible after fallback.`,
      ],
    );

    const evidencePath = await fixture.evidence.writeJson(
      "projection-replay-contract",
      {
        markTree: projection.state.markTree,
        visibleMessages: projection.messages.map((message) => ({
          source: message.source,
          text: message.contentText,
        })),
      },
    );
    assert.match(evidencePath, /projection-replay-contract\.json$/u);
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
