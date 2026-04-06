import assert from "node:assert/strict";
import * as http from "node:http";
import * as https from "node:https";
import test from "node:test";

import { createHermeticE2EFixture } from "./fixture.js";
import { UnauthorizedNetworkAccessError } from "./network-deny.js";

test(
  "hermetic fixture denies fetch and Node HTTP clients immediately",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "harness",
      caseName: "network deny",
    });

    await assert.rejects(
      () => fetch("https://example.com/resource"),
      (error) => {
        assert.ok(error instanceof UnauthorizedNetworkAccessError);
        assert.equal(error.operation, "fetch");
        assert.equal(error.target, "https://example.com/resource");
        return true;
      },
    );

    assert.throws(
      () => http.get("http://example.com/health"),
      (error) => {
        assert.ok(error instanceof UnauthorizedNetworkAccessError);
        assert.equal(error.operation, "http.get");
        assert.equal(error.target, "http://example.com/health");
        return true;
      },
    );

    assert.throws(
      () => https.request(new URL("https://example.com/model")),
      (error) => {
        assert.ok(error instanceof UnauthorizedNetworkAccessError);
        assert.equal(error.operation, "https.request");
        assert.equal(error.target, "https://example.com/model");
        return true;
      },
    );

    const evidencePath = await fixture.evidence.writeJson("network-deny", {
      sessionID: fixture.sessionID,
      blockedOperations: ["fetch", "http.get", "https.request"],
    });

    assert.match(
      evidencePath,
      /\.sisyphus\/evidence\/task-3-hermetic-e2e\/e2e-harness--network-deny\/network-deny\.json$/u,
    );
  },
);
