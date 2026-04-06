import assert from "node:assert/strict";
import test from "node:test";

import { createHermeticE2EFixture } from "../harness/fixture.js";
import {
  CompactionTransportConfigurationError,
  buildCompactionTransportRequest,
} from "../../../src/compaction/transport/index.js";
import { createCompactionRunner } from "../../../src/compaction/runner.js";

test(
  "compaction runner fails fast when no injected transport is configured",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "missing transport config error",
    });
    const runner = createCompactionRunner({});
    const request = buildCompactionTransportRequest({
      sessionID: fixture.sessionID,
      markID: "mark-missing-transport",
      model: "openai.right/gpt-5.4-mini",
      executionMode: "compact",
      allowDelete: false,
      promptText: "This call should fail before any transport executes.",
      timeoutMs: 2_000,
      transcript: [
        {
          role: "user",
          hostMessageID: "host-user-1",
          canonicalMessageID: "canon-user-1",
          contentText: "Please compact this.",
        },
      ],
    });

    await assert.rejects(
      () => runner.run(request),
      (error: unknown) => {
        assert.ok(error instanceof CompactionTransportConfigurationError);
        assert.match(error.message, /requires an injected safe transport adapter/u);
        assert.match(error.message, /No default live executor/u);
        return true;
      },
    );

    const evidencePath = await fixture.evidence.writeText(
      "missing-transport-config-error",
      "Missing transport failed fast before any live execution path was available.",
    );
    assert.match(evidencePath, /missing-transport-config-error\.txt$/u);
  },
);
