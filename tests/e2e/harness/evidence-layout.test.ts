import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createHermeticE2EFixture } from "./fixture.js";

test(
  "hermetic fixture standardizes session naming and evidence layout",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "plugin loading",
      caseName: "compact happy path",
    });

    assert.equal(
      fixture.sessionID,
      "e2e-plugin-loading--compact-happy-path",
    );
    assert.match(fixture.sessionID, /^e2e-[a-z0-9-]+--[a-z0-9-]+$/u);
    assert.match(
      fixture.evidence.sessionDirectory,
      /\.sisyphus\/evidence\/task-3-hermetic-e2e\/e2e-plugin-loading--compact-happy-path$/u,
    );

    const notePath = await fixture.evidence.writeText(
      "operator summary",
      "hermetic fixture manifest created",
    );
    const payloadPath = await fixture.evidence.writeJson("projection snapshot", {
      sessionID: fixture.sessionID,
      summary: "synthetic evidence",
    });

    assert.match(notePath, /operator-summary\.txt$/u);
    assert.match(payloadPath, /projection-snapshot\.json$/u);

    const manifest = JSON.parse(
      await readFile(fixture.evidence.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(manifest, {
      conventionVersion: 1,
      sessionID: "e2e-plugin-loading--compact-happy-path",
      suite: "plugin loading",
      caseName: "compact happy path",
      networkPolicy: "deny-by-default",
      transportPolicy: "inject-safe-transport",
      runner: "node-test-runner",
    });
  },
);
