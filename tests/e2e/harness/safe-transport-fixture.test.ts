import assert from "node:assert/strict";
import test from "node:test";

import { createHermeticE2EFixture } from "./fixture.js";
import {
  createScriptedSafeTransportFixture,
  injectSafeTransport,
  SafeTransportFailureError,
  SafeTransportTimeoutError,
} from "./safe-transport-fixture.js";

interface TransportRequest {
  readonly sessionID: string;
  readonly executionMode: "compact" | "delete";
  readonly model: string;
}

interface TransportResponse {
  readonly contentText: string;
}

test(
  "scripted safe transport fixture provides deterministic success failure and timeout outcomes",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "harness",
      caseName: "safe transport fixture",
    });
    const scriptedTransport = createScriptedSafeTransportFixture<
      TransportRequest,
      TransportResponse
    >([
      {
        kind: "success",
        result: { contentText: "compact result" },
        assertRequest(request) {
          assert.equal(request.sessionID, fixture.sessionID);
          assert.equal(request.executionMode, "compact");
        },
      },
      {
        kind: "failure",
        message: "fixture rejected the request deterministically",
        assertRequest(request) {
          assert.equal(request.executionMode, "delete");
        },
      },
      {
        kind: "timeout",
        timeoutMs: 250,
      },
    ]);

    const runtime = injectSafeTransport(
      { scheduler: "repo-owned-fixture" },
      scriptedTransport,
    );

    const success = await runtime.transport.invoke({
      sessionID: fixture.sessionID,
      executionMode: "compact",
      model: "gpt-5.4-mini",
    });
    assert.deepEqual(success, { contentText: "compact result" });

    await assert.rejects(
      () =>
        runtime.transport.invoke({
          sessionID: fixture.sessionID,
          executionMode: "delete",
          model: "gpt-5.4-mini",
        }),
      (error) => {
        assert.ok(error instanceof SafeTransportFailureError);
        assert.match(error.message, /fixture rejected/u);
        return true;
      },
    );

    await assert.rejects(
      () =>
        runtime.transport.invoke({
          sessionID: fixture.sessionID,
          executionMode: "compact",
          model: "gpt-5.4-mini",
        }),
      (error) => {
        assert.ok(error instanceof SafeTransportTimeoutError);
        assert.equal(error.timeoutMs, 250);
        return true;
      },
    );

    assert.equal(scriptedTransport.remainingSteps(), 0);
    scriptedTransport.assertConsumed();
    assert.deepEqual(scriptedTransport.calls, [
      {
        callIndex: 0,
        stepKind: "success",
        request: {
          sessionID: fixture.sessionID,
          executionMode: "compact",
          model: "gpt-5.4-mini",
        },
      },
      {
        callIndex: 1,
        stepKind: "failure",
        request: {
          sessionID: fixture.sessionID,
          executionMode: "delete",
          model: "gpt-5.4-mini",
        },
      },
      {
        callIndex: 2,
        stepKind: "timeout",
        request: {
          sessionID: fixture.sessionID,
          executionMode: "compact",
          model: "gpt-5.4-mini",
        },
      },
    ]);

    const evidencePath = await fixture.evidence.writeJson(
      "safe-transport-calls",
      scriptedTransport.calls,
    );
    assert.match(
      evidencePath,
      /\.sisyphus\/evidence\/task-3-hermetic-e2e\/e2e-harness--safe-transport-fixture\/safe-transport-calls\.json$/u,
    );
  },
);
