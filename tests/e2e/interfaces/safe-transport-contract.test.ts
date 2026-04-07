import assert from "node:assert/strict";
import test from "node:test";

import { createHermeticE2EFixture } from "../harness/fixture.js";
import {
  CompactionTransportAbortedError,
  CompactionTransportMalformedPayloadError,
  CompactionTransportRetryableError,
  CompactionTransportTimeoutError,
  buildCompactionTransportRequest,
  createScriptedCompactionTransport,
} from "../../../src/compaction/transport/index.js";
import { createCompactionRunner } from "../../../src/compaction/runner.js";

test(
  "safe transport contract validates request input, response payloads, timeout, malformed payload, and retryable errors",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "safe transport contract",
    });

    const scriptedTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: { contentText: "Condensed replacement text." },
        assertRequest(request) {
          assert.equal(request.sessionID, fixture.sessionID);
          assert.equal(request.markID, "mark-001");
          assert.equal(request.executionMode, "compact");
          assert.equal(request.timeoutMs, 15_000);
          assert.equal(request.transcript.length, 2);
          assert.equal(request.transcript[0]?.sequenceNumber, 1);
          assert.equal(request.transcript[1]?.sequenceNumber, 2);
        },
      },
      {
        kind: "success",
        rawPayload: { contentText: 42 },
      },
      {
        kind: "retryable-error",
        message: "provider returned a retryable 429",
        code: "rate_limited",
      },
      {
        kind: "timeout",
        timeoutMs: 15_000,
      },
    ]);

    const runner = createCompactionRunner({
      transport: scriptedTransport.transport,
    });
    const request = buildCompactionTransportRequest({
      sessionID: fixture.sessionID,
      markID: "mark-001",
      model: "openai.right/gpt-5.4-mini",
      executionMode: "compact",
      promptText: "Compress the marked transcript.",
      timeoutMs: 15_000,
      transcript: [
        {
          role: "user",
          hostMessageID: "host-user-1",
          contentText: "Please summarize the tool work.",
        },
        {
          role: "tool",
          hostMessageID: "host-tool-1",
          contentText: "Fetched detailed project state.",
        },
      ],
    });

    const success = await runner.run(request);
    assert.deepEqual(success, {
      contentText: "Condensed replacement text.",
    });

    await assert.rejects(
      () => runner.run(request),
      (error: unknown) => {
        assert.ok(error instanceof CompactionTransportMalformedPayloadError);
        assert.deepEqual(error.rawPayload, { contentText: 42 });
        assert.match(error.message, /Malformed compaction transport payload/u);
        return true;
      },
    );

    await assert.rejects(
      () => runner.run(request),
      (error: unknown) => {
        assert.ok(error instanceof CompactionTransportRetryableError);
        assert.equal(error.retryable, true);
        assert.equal(error.code, "rate_limited");
        return true;
      },
    );

    await assert.rejects(
      () => runner.run(request),
      (error: unknown) => {
        assert.ok(error instanceof CompactionTransportTimeoutError);
        assert.equal(error.timeoutMs, 15_000);
        return true;
      },
    );

    scriptedTransport.assertConsumed();
    assert.equal(scriptedTransport.calls.length, 4);
    assert.deepEqual(scriptedTransport.calls[1]?.outcome, {
      kind: "success",
      rawPayload: { contentText: 42 },
    });

    const evidencePath = await fixture.evidence.writeJson(
      "safe-transport-contract-calls",
      scriptedTransport.calls,
    );
    assert.match(evidencePath, /safe-transport-contract-calls\.json$/u);
  },
);

test(
  "safe transport contract exposes caller abort and transport cancel semantics without consuming a cancelled preflight step",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "safe transport abort cancel semantics",
    });

    const scriptedTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: { contentText: "still pending" },
      },
      {
        kind: "cancelled",
        reason: "scheduler cancelled stale compaction batch",
      },
    ]);
    const runner = createCompactionRunner({
      transport: scriptedTransport.transport,
    });
    const abortController = new AbortController();
    abortController.abort("operator cancelled request");

    const abortedRequest = buildCompactionTransportRequest({
      sessionID: fixture.sessionID,
      markID: "mark-abort",
      model: "openai.right/gpt-5.4-mini",
      executionMode: "compact",
      promptText: "Abort before sending.",
      timeoutMs: 5_000,
      signal: abortController.signal,
      transcript: [
        {
          role: "assistant",
          hostMessageID: "host-assistant-1",
          contentText: "Working on it.",
        },
      ],
    });

    await assert.rejects(
      () => runner.run(abortedRequest),
      (error: unknown) => {
        assert.ok(error instanceof CompactionTransportAbortedError);
        assert.equal(error.origin, "caller");
        assert.equal(error.reason, "operator cancelled request");
        return true;
      },
    );

    assert.equal(scriptedTransport.remainingSteps(), 2);

    const activeRequest = buildCompactionTransportRequest({
      sessionID: fixture.sessionID,
      markID: "mark-cancel",
      model: "openai.right/gpt-5.4-mini",
      executionMode: "compact",
      promptText: "Send one real call so the transport-origin cancel is next.",
      timeoutMs: 5_000,
      transcript: [
        {
          role: "tool",
          hostMessageID: "host-tool-2",
          contentText: "Interim tool output.",
        },
      ],
    });

    const preCancel = await runner.run(activeRequest);
    assert.equal(preCancel.contentText, "still pending");

    await assert.rejects(
      () => runner.run(activeRequest),
      (error: unknown) => {
        assert.ok(error instanceof CompactionTransportAbortedError);
        assert.equal(error.origin, "transport");
        assert.equal(error.reason, "scheduler cancelled stale compaction batch");
        return true;
      },
    );

    scriptedTransport.assertConsumed();
    assert.deepEqual(scriptedTransport.calls.map((call) => call.outcome.kind), [
      "aborted",
      "success",
      "aborted",
    ]);
  },
);
