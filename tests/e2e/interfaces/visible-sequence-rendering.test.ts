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
import {
  createMessagesTransformHook,
  createProjectionBackedMessagesTransformProjector,
} from "../../../src/runtime/messages-transform.js";
import { resolveSessionDatabasePath, resolvePluginStateDirectory } from "../../../src/runtime/sidecar-layout.js";
import { createResultGroupRepository } from "../../../src/state/result-group-repository.js";
import {
  bootstrapSessionSidecar,
  openSessionSidecarRepository,
} from "../../../src/state/sidecar-store.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "visible ids stay stable for assistant and tool output while reminders remain plain text artifacts",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "visible sequence rendering",
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
      allocateAt: () => "2026-04-06T09:00:00.000Z",
    });

    const hostHistory = [
      hostEntry(1, createMessage("msg-system-1", "system", "System guidance.")),
      hostEntry(2, createMessage("msg-assistant-1", "assistant", "I can help with that.")),
      hostEntry(3, createMessage("msg-tool-1", "tool", "Search results arrive here.")),
    ] as const;

    const expectedIds = {
      system: await identity.allocateVisibleId("msg-system-1", "protected"),
      assistant: await identity.allocateVisibleId("msg-assistant-1", "compressible"),
      tool: await identity.allocateVisibleId("msg-tool-1", "compressible"),
    };

    const projectionBuilder = createProjectionBuilder({
      historyReplayReader: createHistoryReplayReaderFromSources({
        sessionId: fixture.sessionID,
        hostHistory,
        toolHistory: [],
      }),
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
          "soft-compact": "Soft compact reminder.",
          "soft-delete": "Soft delete reminder.",
          "hard-compact": "Hard compact reminder.",
          "hard-delete": "Hard delete reminder.",
        },
      }),
      leadingUserPromptText:
        "Do not invent, rewrite, or autocomplete visible message IDs. Copy only the IDs that already appear verbatim in this prompt.",
    });

    const hook = createMessagesTransformHook({
      projector: createProjectionBackedMessagesTransformProjector({
        buildProjection: async () =>
          projectionBuilder.build({
            sessionId: fixture.sessionID,
          }),
      }),
    });

    const output = { messages: [] as Array<Record<string, unknown>> };
    await hook({} as never, output as never);

    const projectedTexts = output.messages.map((message) => {
      const parts = message.parts as Array<{ text?: string }>;
      return parts[0]?.text ?? "";
    });
    assert.deepEqual(projectedTexts, [
      "Do not invent, rewrite, or autocomplete visible message IDs. Copy only the IDs that already appear verbatim in this prompt.",
      `[${expectedIds.system.assignedVisibleId}] System guidance.`,
      `[${expectedIds.assistant.assignedVisibleId}] I can help with that.`,
      "Soft compact reminder.",
      `[${expectedIds.tool.assignedVisibleId}] Search results arrive here.`,
    ]);
    assert.match(expectedIds.assistant.assignedVisibleId, /^compressible_000002_[0-9A-Za-z]{2}$/u);
    assert.match(expectedIds.tool.assignedVisibleId, /^compressible_000003_[0-9A-Za-z]{2}$/u);

    const secondProjection = await projectionBuilder.build({
      sessionId: fixture.sessionID,
    });
    assert.equal(secondProjection.reminders.length, 1);
    assert.match(
      secondProjection.reminders[0]?.visibleId ?? "",
      /^reminder_000002_[0-9A-Za-z]{2}$/u,
    );
    assert.equal(secondProjection.reminders[0]?.contentText, "Soft compact reminder.");

    const evidencePath = await fixture.evidence.writeJson(
      "visible-sequence-rendering",
      {
        assignedVisibleIds: expectedIds,
        renderedTexts: projectedTexts,
        reminder: secondProjection.reminders[0],
      },
    );
    assert.match(evidencePath, /visible-sequence-rendering\.json$/u);
  },
);

test(
  "projection strips a leading fake visible id before prepending the real one",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "leading-visible-id-normalization",
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
      allocateAt: () => "2026-04-06T09:30:00.000Z",
    });

    const hostHistory = [
      hostEntry(1, createMessage("msg-assistant-fake", "assistant", "[compressible_000001_El]I can help with that.")),
      hostEntry(2, createMessage("msg-tool-fake", "tool", "[referable_000002_Ab] Search results arrive here.")),
    ] as const;

    const expectedIds = {
      assistant: await identity.allocateVisibleId("msg-assistant-fake", "compressible"),
      tool: await identity.allocateVisibleId("msg-tool-fake", "compressible"),
    };

    const projectionBuilder = createProjectionBuilder({
      historyReplayReader: createHistoryReplayReaderFromSources({
        sessionId: fixture.sessionID,
        hostHistory,
        toolHistory: [],
      }),
      policyEngine: createFlatPolicyEngine({
        smallUserMessageThreshold: 5,
      }),
      resultGroupRepository: resultGroups,
      canonicalIdentityService: identity,
      reminderService: createConfiguredReminderService({
        hsoft: 10_000,
        hhard: 20_000,
        softRepeatEveryTokens: 10_000,
        hardRepeatEveryTokens: 10_000,
        allowDelete: false,
        promptTextByKind: {
          "soft-compact": "Soft compact reminder.",
          "soft-delete": "Soft delete reminder.",
          "hard-compact": "Hard compact reminder.",
          "hard-delete": "Hard delete reminder.",
        },
      }),
      leadingUserPromptText:
        "Do not invent, rewrite, or autocomplete visible message IDs. Copy only the IDs that already appear verbatim in this prompt.",
    });

    const hook = createMessagesTransformHook({
      projector: createProjectionBackedMessagesTransformProjector({
        buildProjection: async () =>
          projectionBuilder.build({
            sessionId: fixture.sessionID,
          }),
      }),
    });

    const output = { messages: [] as Array<Record<string, unknown>> };
    await hook({} as never, output as never);

    const projectedTexts = output.messages.map((message) => {
      const parts = message.parts as Array<{ text?: string }>;
      return parts[0]?.text ?? "";
    });

    assert.deepEqual(projectedTexts, [
      "Do not invent, rewrite, or autocomplete visible message IDs. Copy only the IDs that already appear verbatim in this prompt.",
      `[${expectedIds.assistant.assignedVisibleId}] I can help with that.`,
      `[${expectedIds.tool.assignedVisibleId}] Search results arrive here.`,
    ]);
    assert.equal(
      projectedTexts[0]?.includes("[compressible_000001_El]"),
      false,
    );
    assert.equal(
      projectedTexts[1]?.includes("[referable_000002_Ab]"),
      false,
    );
  },
);

test(
  "compressed replacement messages include a compressed reasoning part",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "replacement reasoning part",
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
      hostEntry(1, createMessage("msg-assistant-1", "assistant", "Assistant content that will be compressed.")),
    ] as const;
    const assistantId = await identity.allocateVisibleId("msg-assistant-1", "compressible");
    await resultGroups.upsertCompleteGroup({
      markId: "mark-replacement",
      mode: "compact",
      sourceStartSeq: 1,
      sourceEndSeq: 1,
      executionMode: "compact",
      createdAt: "2026-04-06T10:00:00.000Z",
      committedAt: "2026-04-06T10:00:01.000Z",
      fragments: [
        {
          sourceStartSeq: 1,
          sourceEndSeq: 1,
          replacementText: "Compressed replacement.",
        },
      ],
    });

    const projectionBuilder = createProjectionBuilder({
      historyReplayReader: createHistoryReplayReaderFromSources({
        sessionId: fixture.sessionID,
        hostHistory,
        toolHistory: [
          {
            sequence: 2,
            sourceMessageId: "tool-mark-replacement",
            toolName: "compression_mark",
            input: {
              mode: "compact",
              from: assistantId.assignedVisibleId,
              to: assistantId.assignedVisibleId,
            },
            result: {
              ok: true,
              markId: "mark-replacement",
            },
          },
        ],
      }),
      policyEngine: createFlatPolicyEngine({
        smallUserMessageThreshold: 5,
      }),
      resultGroupRepository: resultGroups,
      canonicalIdentityService: identity,
      reminderService: createConfiguredReminderService({
        hsoft: 10_000,
        hhard: 20_000,
        softRepeatEveryTokens: 10_000,
        hardRepeatEveryTokens: 10_000,
        allowDelete: false,
        promptTextByKind: {
          "soft-compact": "Soft compact reminder.",
          "soft-delete": "Soft delete reminder.",
          "hard-compact": "Hard compact reminder.",
          "hard-delete": "Hard delete reminder.",
        },
      }),
    });

    const hook = createMessagesTransformHook({
      projector: createProjectionBackedMessagesTransformProjector({
        buildProjection: async () =>
          projectionBuilder.build({
            sessionId: fixture.sessionID,
          }),
      }),
    });

    const output = { messages: [] as Array<Record<string, unknown>> };
    await hook({} as never, output as never);
    const replacement = output.messages.find((message) => {
      const parts = message.parts as Array<{ text?: string; type: string }>;
      return parts.some((part) => part.text?.includes("Compressed replacement."));
    });
    const parts = replacement?.parts as Array<{ type: string; text?: string }> | undefined;

    assert.ok(parts);
    assert.deepEqual(
      parts.filter((part) => part.type === "reasoning").map((part) => part.text),
      ["compressed"],
    );
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
