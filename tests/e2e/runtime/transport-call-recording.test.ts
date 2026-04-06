import assert from "node:assert/strict";
import test from "node:test";

import { createHermeticE2EFixture } from "../harness/fixture.js";
import {
  buildCompactionTransportRequest,
  createScriptedCompactionTransport,
} from "../../../src/compaction/transport/index.js";
import { createCompactionRunner } from "../../../src/compaction/runner.js";

test(
  "scripted compaction transport records requests and outcomes for hermetic e2e assertions",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "transport call recording",
    });
    const scriptedTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: { contentText: "first compact result" },
      },
      {
        kind: "retryable-error",
        message: "temporary provider saturation",
        code: "busy",
      },
      {
        kind: "timeout",
        timeoutMs: 9_000,
      },
    ]);
    const runner = createCompactionRunner({
      transport: scriptedTransport.transport,
    });
    const baseRequest = buildCompactionTransportRequest({
      sessionID: fixture.sessionID,
      markID: "mark-recorded",
      model: "openai.doro/gpt-5.4-mini",
      executionMode: "compact",
      allowDelete: false,
      promptText: "Compact the selected transcript.",
      timeoutMs: 9_000,
      transcript: [
        {
          role: "user",
          hostMessageID: "host-user-1",
          canonicalMessageID: "canon-user-1",
          contentText: "Investigate the regression.",
        },
        {
          role: "assistant",
          hostMessageID: "host-assistant-1",
          canonicalMessageID: "canon-assistant-1",
          contentText: "I am checking the logs now.",
        },
      ],
    });

    const success = await runner.run(baseRequest);
    assert.equal(success.contentText, "first compact result");

    await assert.rejects(() => runner.run(baseRequest));
    await assert.rejects(() => runner.run(baseRequest));

    scriptedTransport.assertConsumed();
    assert.deepEqual(scriptedTransport.calls, [
      {
        callIndex: 0,
        request: {
          sessionID: fixture.sessionID,
          markID: "mark-recorded",
          model: "openai.doro/gpt-5.4-mini",
          executionMode: "compact",
          allowDelete: false,
          promptText: "Compact the selected transcript.",
          transcript: [
            {
              sequenceNumber: 1,
              role: "user",
              hostMessageID: "host-user-1",
              canonicalMessageID: "canon-user-1",
              contentText: "Investigate the regression.",
            },
            {
              sequenceNumber: 2,
              role: "assistant",
              hostMessageID: "host-assistant-1",
              canonicalMessageID: "canon-assistant-1",
              contentText: "I am checking the logs now.",
            },
          ],
          timeoutMs: 9_000,
          signalState: "missing",
        },
        outcome: {
          kind: "success",
          rawPayload: { contentText: "first compact result" },
        },
      },
      {
        callIndex: 1,
        request: {
          sessionID: fixture.sessionID,
          markID: "mark-recorded",
          model: "openai.doro/gpt-5.4-mini",
          executionMode: "compact",
          allowDelete: false,
          promptText: "Compact the selected transcript.",
          transcript: [
            {
              sequenceNumber: 1,
              role: "user",
              hostMessageID: "host-user-1",
              canonicalMessageID: "canon-user-1",
              contentText: "Investigate the regression.",
            },
            {
              sequenceNumber: 2,
              role: "assistant",
              hostMessageID: "host-assistant-1",
              canonicalMessageID: "canon-assistant-1",
              contentText: "I am checking the logs now.",
            },
          ],
          timeoutMs: 9_000,
          signalState: "missing",
        },
        outcome: {
          kind: "retryable-error",
          message: "temporary provider saturation",
          code: "busy",
        },
      },
      {
        callIndex: 2,
        request: {
          sessionID: fixture.sessionID,
          markID: "mark-recorded",
          model: "openai.doro/gpt-5.4-mini",
          executionMode: "compact",
          allowDelete: false,
          promptText: "Compact the selected transcript.",
          transcript: [
            {
              sequenceNumber: 1,
              role: "user",
              hostMessageID: "host-user-1",
              canonicalMessageID: "canon-user-1",
              contentText: "Investigate the regression.",
            },
            {
              sequenceNumber: 2,
              role: "assistant",
              hostMessageID: "host-assistant-1",
              canonicalMessageID: "canon-assistant-1",
              contentText: "I am checking the logs now.",
            },
          ],
          timeoutMs: 9_000,
          signalState: "missing",
        },
        outcome: {
          kind: "timeout",
          timeoutMs: 9_000,
        },
      },
    ]);

    const evidencePath = await fixture.evidence.writeJson(
      "transport-call-recording",
      scriptedTransport.calls,
    );
    assert.match(evidencePath, /transport-call-recording\.json$/u);
  },
);
