import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { InvalidCompactionOutputError } from "../../../src/compaction/errors.js";
import { createCompactionInputBuilder } from "../../../src/compaction/input-builder.js";
import { createOutputValidator } from "../../../src/compaction/output-validation.js";
import { createContractLevelCompactionRunner } from "../../../src/compaction/runner.js";
import {
  CompactionTransportMalformedPayloadError,
  CompactionTransportTimeoutError,
  createScriptedCompactionTransport,
} from "../../../src/compaction/transport/index.js";
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
  "output validation rejects invalid compact output and malformed payloads while preserving visible state",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "compaction",
      caseName: "output validation",
    });
    const stateDirectory = resolvePluginStateDirectory(fixture.repoRoot);
    const databasePath = resolveSessionDatabasePath(stateDirectory, fixture.sessionID);
    await rm(databasePath, { force: true });
    await bootstrapSessionSidecar({ databasePath });

    const sidecar = await openSessionSidecarRepository({ databasePath });
    t.after(() => sidecar.close());

    const resultGroups = createResultGroupRepository(sidecar);
    await resultGroups.upsertCompleteGroup({
      markId: "mark-existing",
      mode: "compact",
      sourceStartSeq: 1,
      sourceEndSeq: 1,
      executionMode: "compact",
      createdAt: "2026-04-06T12:00:00.000Z",
      committedAt: "2026-04-06T12:00:01.000Z",
      fragments: [
        {
          sourceStartSeq: 1,
          sourceEndSeq: 1,
          replacementText: "Existing replacement that must survive later failures.",
        },
      ],
    });

    const invalidTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: {
          contentText: "Compact summary that illegally drops the opaque block.",
        },
      },
    ]);
    const invalidRunner = createContractLevelCompactionRunner({
      inputBuilder: createCompactionInputBuilder(),
      transport: createSafeTransportAdapter(invalidTransport.transport),
      outputValidator: createOutputValidator(),
      resultGroupRepository: resultGroups,
    });

    await assert.rejects(
      () =>
        invalidRunner.run({
          build: compactBuild(fixture.sessionID, "mark-invalid"),
          maxAttemptsPerModel: 1,
          resultGroup: {
            sourceStartSeq: 10,
            sourceEndSeq: 13,
            createdAt: "2026-04-06T12:10:00.000Z",
            committedAt: "2026-04-06T12:10:01.000Z",
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidCompactionOutputError);
        assert.match(error.message, /preserve opaque placeholder 'S1'/u);
        return true;
      },
    );
    invalidTransport.assertConsumed();
    assert.equal(await resultGroups.getCompleteGroup("mark-invalid"), null);
    assert.equal(
      (await resultGroups.getCompleteGroup("mark-existing"))?.fragments[0]?.replacementText,
      "Existing replacement that must survive later failures.",
    );

    const malformedTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: {
          contentText: 42,
        },
      },
    ]);
    const malformedRunner = createContractLevelCompactionRunner({
      inputBuilder: createCompactionInputBuilder(),
      transport: createSafeTransportAdapter(malformedTransport.transport),
      outputValidator: createOutputValidator(),
      resultGroupRepository: resultGroups,
    });

    await assert.rejects(
      () =>
        malformedRunner.run({
          build: compactBuild(fixture.sessionID, "mark-malformed"),
          maxAttemptsPerModel: 1,
          resultGroup: {
            sourceStartSeq: 20,
            sourceEndSeq: 23,
            createdAt: "2026-04-06T12:11:00.000Z",
            committedAt: "2026-04-06T12:11:01.000Z",
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof CompactionTransportMalformedPayloadError);
        return true;
      },
    );
    malformedTransport.assertConsumed();
    assert.equal(await resultGroups.getCompleteGroup("mark-malformed"), null);

    const deleteTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: {
          contentText: "[deleted span notice]",
        },
      },
    ]);
    const deleteRunner = createContractLevelCompactionRunner({
      inputBuilder: createCompactionInputBuilder(),
      transport: createSafeTransportAdapter(deleteTransport.transport),
      outputValidator: createOutputValidator(),
      resultGroupRepository: resultGroups,
    });

    const deleteResult = await deleteRunner.run({
      build: {
        ...compactBuild(fixture.sessionID, "mark-delete"),
        executionMode: "delete",
      },
      maxAttemptsPerModel: 1,
      resultGroup: {
        sourceStartSeq: 30,
        sourceEndSeq: 33,
        createdAt: "2026-04-06T12:12:00.000Z",
        committedAt: "2026-04-06T12:12:01.000Z",
      },
    });
    deleteTransport.assertConsumed();
    assert.equal(deleteResult.validatedOutput.contentText, "[deleted span notice]");
    assert.equal((await resultGroups.getCompleteGroup("mark-delete"))?.mode, "delete");
    assert.equal(
      (await resultGroups.getCompleteGroup("mark-delete"))?.fragments[0]?.replacementText,
      "[deleted span notice]",
    );

    const timeoutTransport = createScriptedCompactionTransport([
      {
        kind: "timeout",
        timeoutMs: 9_000,
      },
    ]);
    const timeoutRunner = createContractLevelCompactionRunner({
      inputBuilder: createCompactionInputBuilder(),
      transport: createSafeTransportAdapter(timeoutTransport.transport),
      outputValidator: createOutputValidator(),
      resultGroupRepository: resultGroups,
    });

    await assert.rejects(
      () =>
        timeoutRunner.run({
          build: compactBuild(fixture.sessionID, "mark-timeout"),
          maxAttemptsPerModel: 1,
          resultGroup: {
            sourceStartSeq: 40,
            sourceEndSeq: 43,
            createdAt: "2026-04-06T12:13:00.000Z",
            committedAt: "2026-04-06T12:13:01.000Z",
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof CompactionTransportTimeoutError);
        assert.equal(error.timeoutMs, 9_000);
        return true;
      },
    );
    timeoutTransport.assertConsumed();
    assert.equal(await resultGroups.getCompleteGroup("mark-timeout"), null);

    const evidencePath = await fixture.evidence.writeJson(
      "output-validation-state",
      await resultGroups.listGroupsOverlappingRange(1, 50),
    );
    assert.match(evidencePath, /output-validation-state\.json$/u);
  },
);

function compactBuild(sessionId: string, markId: string) {
  return {
    sessionId,
    markId,
    model: "model-primary",
    executionMode: "compact" as const,
    promptText: "Compress this range and preserve the opaque placeholder.",
    timeoutMs: 9_000,
    transcript: [
      {
        role: "assistant" as const,
        hostMessageId: `${markId}-host-1`,
        sourceStartSeq: 10,
        sourceEndSeq: 10,
        contentText: "Lead compressible message.",
      },
      {
        role: "assistant" as const,
        hostMessageId: `${markId}-host-opaque`,
        sourceStartSeq: 11,
        sourceEndSeq: 12,
        opaquePlaceholder: {
          slot: "S1",
        },
        contentText: "Opaque compact result.",
      },
      {
        role: "tool" as const,
        hostMessageId: `${markId}-host-3`,
        sourceStartSeq: 13,
        sourceEndSeq: 13,
        contentText: "Tail compressible tool result.",
      },
    ],
  };
}
