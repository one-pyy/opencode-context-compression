import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_PARAMS_EXTERNAL_CONTRACT,
  CHAT_PARAMS_METADATA_KEY,
  createChatParamsSchedulerHook,
} from "../../../src/runtime/chat-params-scheduler.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "chat.params stays narrow and only writes scheduler metadata",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "chat params narrowing",
    });

    const hook = createChatParamsSchedulerHook({
      scheduler: {
        schedule() {
          return {
            metadata: {
              contractVersion: "v1",
              schedulerState: "eligible",
              scheduled: false,
              reason: "waiting for later scheduler/runtime tasks",
              activeCompactionLock: false,
              pendingMarkCount: 0,
            },
          };
        },
      },
    });

    const output: {
      temperature: number;
      topP: number;
      topK: number;
      options: Record<string, unknown>;
    } = {
      temperature: 0.4,
      topP: 0.9,
      topK: 50,
      options: {
        existingFlag: true,
      },
    };

    await hook(
      {
        sessionID: fixture.sessionID,
        agent: "atlas",
        model: {
          id: "model-1",
          name: "gpt-5.4-mini",
          provider: "openai.right",
        } as never,
        provider: {
          source: "custom",
          info: {} as never,
          options: {},
        },
        message: {
          id: "msg-chat-params",
          sessionID: fixture.sessionID,
          role: "user",
          time: { created: 1 },
          agent: "atlas",
          model: {
            providerID: "openai.right",
            modelID: "gpt-5.4-mini",
          },
        },
      },
      output,
    );

    assert.equal(output.temperature, 0.4);
    assert.equal(output.topP, 0.9);
    assert.equal(output.topK, 50);
    assert.equal(output.options.existingFlag, true);
    assert.deepEqual(output.options[CHAT_PARAMS_METADATA_KEY], {
      contractVersion: "v1",
      schedulerState: "eligible",
      scheduled: false,
      reason: "waiting for later scheduler/runtime tasks",
      activeCompactionLock: false,
      pendingMarkCount: 0,
    });

    const forbiddenKeys = [
      "messages",
      "projection",
      "renderedMessages",
      "reminder",
      "visibleIDs",
      "resultGroups",
    ];
    const flattened = JSON.stringify(output.options);
    for (const forbiddenKey of forbiddenKeys) {
      assert.doesNotMatch(flattened, new RegExp(`"${forbiddenKey}"`, "u"));
    }

    assert.equal(
      CHAT_PARAMS_EXTERNAL_CONTRACT.visibleSideEffects[1],
      "must not rewrite messages reminders or visible ids",
    );

    const evidencePath = await fixture.evidence.writeJson("chat-params-narrowing", {
      output,
      contract: CHAT_PARAMS_EXTERNAL_CONTRACT,
    });
    assert.match(evidencePath, /chat-params-narrowing\.json$/u);
  },
);
