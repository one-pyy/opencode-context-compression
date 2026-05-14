import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { PluginInput } from "@opencode-ai/plugin";

import pluginModule from "../../../src/index.js";
import {
  ALLOWED_PLUGIN_EXTERNAL_HOOKS,
  ALLOWED_PLUGIN_EXTERNAL_TOOLS,
  createContextCompressionHooks,
} from "../../../src/runtime/plugin-hooks.js";
import {
  CHAT_PARAMS_EXTERNAL_CONTRACT,
  createInternalChatParamsScheduler,
} from "../../../src/runtime/chat-params-scheduler.js";
import {
  MESSAGES_TRANSFORM_EXTERNAL_CONTRACT,
  createMessagesTransformHook,
} from "../../../src/runtime/messages-transform.js";
import { stripLeadingVisibleMessageId } from "../../../src/runtime/text-complete.js";
import {
  TOOL_EXECUTE_BEFORE_EXTERNAL_CONTRACT,
} from "../../../src/runtime/send-entry-gate.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "plugin exposes only the locked external hooks and context compression tools",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "plugin hooks contract",
    });

    const hooks = createContextCompressionHooks();
    assert.deepEqual(
      Object.keys(hooks).sort(),
      [...ALLOWED_PLUGIN_EXTERNAL_HOOKS, "tool"].sort(),
    );
    assert.deepEqual(
      Object.keys(hooks.tool ?? {}).sort(),
      [...ALLOWED_PLUGIN_EXTERNAL_TOOLS].sort(),
    );

    assert.equal(
      MESSAGES_TRANSFORM_EXTERNAL_CONTRACT.relationToRuntime.scheduler,
      "read-only relative to scheduler and never dispatches jobs",
    );
    assert.equal(
      CHAT_PARAMS_EXTERNAL_CONTRACT.relationToRuntime.replay,
      "does not replay or materialize transcript state",
    );
    assert.equal(
      TOOL_EXECUTE_BEFORE_EXTERNAL_CONTRACT.visibleSideEffects[0],
      "non-DCP tools bypass",
    );

    const repoRoot = fixture.repoRoot;
    const pluginHooks = await pluginModule.server(createPluginInput(repoRoot));
    assert.deepEqual(
      Object.keys(pluginHooks).sort(),
      [...ALLOWED_PLUGIN_EXTERNAL_HOOKS, "tool"].sort(),
    );
    assert.deepEqual(
      Object.keys(pluginHooks.tool ?? {}).sort(),
      [...ALLOWED_PLUGIN_EXTERNAL_TOOLS].sort(),
    );

    const indexSource = await readFile(join(repoRoot, "src", "index.ts"), "utf8");
    assert.ok(indexSource.split(/\r?\n/u).length < 60);
    assert.match(indexSource, /createContextCompressionHooks/u);
    assert.doesNotMatch(indexSource, /INVALID_RANGE|DELETE_NOT_ALLOWED|OVERLAP_CONFLICT/u);

    const evidencePath = await fixture.evidence.writeJson("plugin-hooks-contract", {
      exposedHookKeys: Object.keys(pluginHooks).sort(),
      exposedToolKeys: Object.keys(pluginHooks.tool ?? {}).sort(),
      indexLineCount: indexSource.split(/\r?\n/u).length,
    });
    assert.match(evidencePath, /plugin-hooks-contract\.json$/u);
  },
);

test("plugin entry exports a server function for host plugin loading", async () => {
  const entry = await import("../../../src/index.js");

  assert.equal(typeof entry.default, "object");
  assert.equal(entry.default?.id, "opencode-context-compression");
  assert.equal(typeof entry.default?.server, "function");
  assert.equal(typeof entry.server, "function");
  assert.equal(entry.server, entry.default?.server);
});

test("messages.transform mutates the provided output array in place", async () => {
  const hook = createMessagesTransformHook({
    projector: {
      project() {
        return [
          {
            info: createUserMessage({ id: "msg-user-2" }),
            parts: [
              createTextPart({
                messageID: "msg-user-2",
                id: "part-user-2",
                text: "Reprojected message.",
              }),
            ],
          },
        ];
      },
    },
  });

  const output = {
    messages: [
      {
        info: createUserMessage({ id: "msg-user-1" }),
        parts: [
          createTextPart({
            messageID: "msg-user-1",
            id: "part-user-1",
            text: "Original message.",
          }),
        ],
      },
    ],
  };
  const originalArray = output.messages;

  await hook({}, output);

  assert.equal(output.messages, originalArray);
  assert.equal(output.messages.length, 1);
  assert.equal(output.messages[0]?.info.id, "msg-user-2");
  assert.equal(output.messages[0]?.parts[0]?.type, "text");
});

test("text.complete strips a leading visible msg_id from assistant output", () => {
  assert.equal(
    stripLeadingVisibleMessageId("[compressible_000123_AbCDe123] Assistant answer."),
    "Assistant answer.",
  );
  assert.equal(
    stripLeadingVisibleMessageId("No prefix here."),
    "No prefix here.",
  );
});

test("chat.params scheduler metadata includes mark eligibility diagnostics", async () => {
  const scheduler = createInternalChatParamsScheduler({
    evaluate() {
      return {
        activeCompactionLock: false,
        eligibleMarkIds: [],
        uncompressedMarkedTokenCount: 0,
        markedTokenAutoCompactionThreshold: 50_000,
        diagnostics: {
          replayedMarkCount: 1,
          replayedMarkIds: ["mark_missing_visible_id"],
          markTreeNodeCount: 0,
          markTreeMarkIds: [],
          markTreeConflicts: [
            {
              markId: "mark_missing_visible_id",
              errorCode: "OVERLAP_CONFLICT",
              message:
                "Mark targets an unknown or reversed visible-id range and is excluded from the coverage tree.",
            },
          ],
          queuedMarkIdsBeforeThreshold: [],
          committedResultGroupMarkIds: [],
          uncompressedMarkedTokenCount: 0,
          markedTokenAutoCompactionThreshold: 50_000,
          schedulerMarkThreshold: 1,
          usedCanonicalIdentityService: false,
          visibleIdSamples: [
            {
              canonicalId: "msg-user-1",
              visibleId: "protected_000001_ab",
            },
          ],
        },
      };
    },
  });

  const decision = await scheduler.scheduleIfNeeded("ses-diagnostics");

  assert.equal(decision.metadata?.diagnostics?.replayedMarkCount, 1);
  assert.deepEqual(decision.metadata?.diagnostics?.replayedMarkIds, [
    "mark_missing_visible_id",
  ]);
  assert.equal(decision.metadata?.diagnostics?.markTreeNodeCount, 0);
  assert.equal(
    decision.metadata?.diagnostics?.markTreeConflicts[0]?.markId,
    "mark_missing_visible_id",
  );
  assert.equal(
    decision.metadata?.diagnostics?.usedCanonicalIdentityService,
    false,
  );
});

function createPluginInput(repoRoot: string): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: repoRoot,
    worktree: repoRoot,
    serverUrl: new URL("http://localhost:3900"),
    $: {} as PluginInput["$"],
  };
}

function createUserMessage(overrides: { readonly id: string }) {
  return {
    id: overrides.id,
    sessionID: "session-plugin-contract",
    role: "user" as const,
    time: { created: 1 },
    agent: "atlas",
    model: {
      providerID: "openai.right",
      modelID: "gpt-5.4-mini",
    },
  };
}

function createTextPart(input: {
  readonly id: string;
  readonly messageID: string;
  readonly text: string;
}) {
  return {
    id: input.id,
    sessionID: "session-plugin-contract",
    messageID: input.messageID,
    type: "text" as const,
    text: input.text,
  };
}
