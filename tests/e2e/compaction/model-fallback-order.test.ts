import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { createCompactionInputBuilder } from "../../../src/compaction/input-builder.js";
import { createOutputValidator } from "../../../src/compaction/output-validation.js";
import { createContractLevelCompactionRunner } from "../../../src/compaction/runner.js";
import { createScriptedCompactionTransport } from "../../../src/compaction/transport/index.js";
import { createSafeTransportAdapter } from "../../../src/runtime/compaction-transport.js";
import {
  resolvePluginStateDirectory,
  resolveSessionDatabasePath,
} from "../../../src/runtime/sidecar-layout.js";
import { createResultGroupRepository } from "../../../src/state/result-group-repository.js";
import {
  bootstrapSessionSidecar,
  openSessionSidecarRepository,
} from "../../../src/state/sidecar-store.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "compaction runner retries the same model before falling back through compactionModels order",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "compaction",
      caseName: "model fallback order",
    });
    const stateDirectory = resolvePluginStateDirectory(fixture.repoRoot);
    const databasePath = resolveSessionDatabasePath(stateDirectory, fixture.sessionID);
    await rm(databasePath, { force: true });
    await bootstrapSessionSidecar({ databasePath });

    const sidecar = await openSessionSidecarRepository({ databasePath });
    t.after(() => sidecar.close());

    const resultGroups = createResultGroupRepository(sidecar);
    const scriptedTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: {
          contentText: "Lead summary without the required opaque block.",
        },
        assertRequest(request, callIndex) {
          assert.equal(callIndex, 0);
          assert.equal(request.model, "model-primary");
        },
      },
      {
        kind: "success",
        rawPayload: {
          contentText: "Still invalid because the opaque block vanished again.",
        },
        assertRequest(request, callIndex) {
          assert.equal(callIndex, 1);
          assert.equal(request.model, "model-primary");
        },
      },
      {
        kind: "success",
        rawPayload: {
          contentText:
            'Lead summary. <opaque slot="S1">Protected prior result block.</opaque> Tail summary.',
        },
        assertRequest(request, callIndex) {
          assert.equal(callIndex, 2);
          assert.equal(request.model, "model-backup");
        },
      },
    ]);

    const runner = createContractLevelCompactionRunner({
      inputBuilder: createCompactionInputBuilder(),
      transport: createSafeTransportAdapter(scriptedTransport.transport),
      outputValidator: createOutputValidator(),
      resultGroupRepository: resultGroups,
    });

    const result = await runner.run({
      build: {
        sessionId: fixture.sessionID,
        markId: "mark-fallback-001",
        model: "model-primary",
        executionMode: "compact",
        promptText: "Compress this range and keep the opaque block intact.",
        timeoutMs: 11_000,
        transcript: [
          {
            role: "assistant",
            hostMessageId: "host-1",
            sourceStartSeq: 30,
            sourceEndSeq: 30,
            contentText: "Lead context.",
          },
          {
            role: "assistant",
            hostMessageId: "host-opaque",
            sourceStartSeq: 31,
            sourceEndSeq: 32,
            opaquePlaceholder: {
              slot: "S1",
            },
            contentText: "Protected prior result block.",
          },
          {
            role: "tool",
            hostMessageId: "host-3",
            sourceStartSeq: 33,
            sourceEndSeq: 33,
            contentText: "Tail context.",
          },
        ],
      },
      compactionModels: ["model-primary", "model-backup", "model-tertiary"],
      maxAttemptsPerModel: 2,
      resultGroup: {
        sourceStartSeq: 30,
        sourceEndSeq: 33,
        createdAt: "2026-04-06T12:20:00.000Z",
        committedAt: "2026-04-06T12:20:01.000Z",
      },
    });

    scriptedTransport.assertConsumed();
    assert.equal(result.request.model, "model-backup");
    assert.deepEqual(
      scriptedTransport.calls.map((call) => call.request.model),
      ["model-primary", "model-primary", "model-backup"],
    );

    const stored = await resultGroups.getCompleteGroup("mark-fallback-001");
    assert.ok(stored);
    assert.equal(stored.modelName, "model-backup");
    assert.equal(stored.mode, "compact");
    assert.deepEqual(
      stored.fragments.map((fragment) => ({
        sourceStartSeq: fragment.sourceStartSeq,
        sourceEndSeq: fragment.sourceEndSeq,
        replacementText: fragment.replacementText,
      })),
      [
        {
          sourceStartSeq: 30,
          sourceEndSeq: 30,
          replacementText: "Lead summary.",
        },
        {
          sourceStartSeq: 33,
          sourceEndSeq: 33,
          replacementText: "Tail summary.",
        },
      ],
    );

    const evidencePath = await fixture.evidence.writeJson(
      "model-fallback-order",
      scriptedTransport.calls,
    );
    assert.match(evidencePath, /model-fallback-order\.json$/u);
  },
);
