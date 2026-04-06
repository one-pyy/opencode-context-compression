import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { bootstrapSessionSidecar, openSessionSidecarRepository } from "../../../src/state/sidecar-store.js";
import { createCanonicalIdentityService, CANONICAL_IDENTITY_SERVICE_INTERNAL_CONTRACT } from "../../../src/identity/canonical-identity.js";
import { createCompactionInputBuilder, COMPACTION_INPUT_BUILDER_INTERNAL_CONTRACT } from "../../../src/compaction/input-builder.js";
import { createContractLevelCompactionRunner, COMPACTION_RUNNER_INTERNAL_CONTRACT } from "../../../src/compaction/runner.js";
import { createOutputValidator, OUTPUT_VALIDATOR_INTERNAL_CONTRACT } from "../../../src/compaction/output-validation.js";
import { createFlatPolicyEngine, POLICY_ENGINE_INTERNAL_CONTRACT } from "../../../src/projection/policy-engine.js";
import { createHistoryReplayReader, HISTORY_REPLAY_READER_INTERNAL_CONTRACT, type ReplayedHistory } from "../../../src/history/history-replay-reader.js";
import { createProjectionBuilder, PROJECTION_BUILDER_INTERNAL_CONTRACT } from "../../../src/projection/projection-builder.js";
import { createStaticReminderService, REMINDER_SERVICE_INTERNAL_CONTRACT } from "../../../src/projection/reminder-service.js";
import { createPromptResolverFromLoader, PROMPT_RESOLVER_INTERNAL_CONTRACT } from "../../../src/runtime/prompt-resolver.js";
import { createRuntimeConfigLoader, RUNTIME_CONFIG_LOADER_INTERNAL_CONTRACT } from "../../../src/runtime/runtime-config-loader.js";
import { createSafeTransportAdapter, SAFE_TRANSPORT_ADAPTER_INTERNAL_CONTRACT } from "../../../src/runtime/compaction-transport.js";
import { resolveSessionDatabasePath, resolvePluginStateDirectory } from "../../../src/runtime/sidecar-layout.js";
import { createResultGroupRepository, RESULT_GROUP_REPOSITORY_INTERNAL_CONTRACT } from "../../../src/state/result-group-repository.js";
import { createStaticInternalChatParamsScheduler, CHAT_PARAMS_SCHEDULER_INTERNAL_CONTRACT } from "../../../src/runtime/chat-params-scheduler.js";
import { createStaticSendEntryGate, SEND_ENTRY_GATE_INTERNAL_CONTRACT } from "../../../src/runtime/send-entry-gate.js";
import { createScriptedCompactionTransport } from "../../../src/compaction/transport/index.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

const CONTRACTS = [
  RUNTIME_CONFIG_LOADER_INTERNAL_CONTRACT,
  PROMPT_RESOLVER_INTERNAL_CONTRACT,
  CANONICAL_IDENTITY_SERVICE_INTERNAL_CONTRACT,
  HISTORY_REPLAY_READER_INTERNAL_CONTRACT,
  RESULT_GROUP_REPOSITORY_INTERNAL_CONTRACT,
  PROJECTION_BUILDER_INTERNAL_CONTRACT,
  POLICY_ENGINE_INTERNAL_CONTRACT,
  REMINDER_SERVICE_INTERNAL_CONTRACT,
  COMPACTION_INPUT_BUILDER_INTERNAL_CONTRACT,
  COMPACTION_RUNNER_INTERNAL_CONTRACT,
  OUTPUT_VALIDATOR_INTERNAL_CONTRACT,
  SEND_ENTRY_GATE_INTERNAL_CONTRACT,
  CHAT_PARAMS_SCHEDULER_INTERNAL_CONTRACT,
  SAFE_TRANSPORT_ADAPTER_INTERNAL_CONTRACT,
] as const;

test(
  "internal module contracts expose the locked boundaries and narrow dependency directions",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "internal module contracts",
    });

    assert.deepEqual(
      CONTRACTS.map((contract) => contract.module).sort(),
      [
        "CanonicalIdentityService",
        "ChatParamsScheduler",
        "CompactionInputBuilder",
        "CompactionRunner",
        "HistoryReplayReader",
        "OutputValidator",
        "PolicyEngine",
        "ProjectionBuilder",
        "PromptResolver",
        "ReminderService",
        "ResultGroupRepository",
        "RuntimeConfigLoader",
        "SafeTransportAdapter",
        "SendEntryGate",
      ],
    );

    assert.deepEqual(PROJECTION_BUILDER_INTERNAL_CONTRACT.dependencyDirection.outboundTo, [
      "HistoryReplayReader",
      "PolicyEngine",
      "ResultGroupRepository",
      "CanonicalIdentityService",
      "ReminderService",
    ]);
    assert.deepEqual(COMPACTION_RUNNER_INTERNAL_CONTRACT.dependencyDirection.outboundTo, [
      "CompactionInputBuilder",
      "SafeTransportAdapter",
      "OutputValidator",
      "ResultGroupRepository",
    ]);
    assert.deepEqual(RESULT_GROUP_REPOSITORY_INTERNAL_CONTRACT.dependencyDirection.outboundTo, []);
    assert.ok(
      RESULT_GROUP_REPOSITORY_INTERNAL_CONTRACT.idempotency.includes("byte-identical committed content"),
    );
    assert.ok(
      SAFE_TRANSPORT_ADAPTER_INTERNAL_CONTRACT.errorTypes.includes("TRANSPORT_TIMEOUT"),
    );

    const runtimeConfigLoader = createRuntimeConfigLoader();
    const runtimeConfig = await runtimeConfigLoader.load(fixture.sessionID);
    const promptResolver = await createPromptResolverFromLoader(
      runtimeConfigLoader,
      fixture.sessionID,
    );
    const stateDirectory = resolvePluginStateDirectory(fixture.repoRoot);
    const databasePath = resolveSessionDatabasePath(stateDirectory, fixture.sessionID);
    await rm(databasePath, { force: true });
    await bootstrapSessionSidecar({ databasePath });

    const sidecar = await openSessionSidecarRepository({ databasePath });
    t.after(() => sidecar.close());

    const resultGroups = createResultGroupRepository(sidecar);
    assert.deepEqual(Object.keys(resultGroups).sort(), [
      "allocateVisibleId",
      "getCompleteGroup",
      "getVisibleId",
      "listGroupsOverlappingRange",
      "upsertCompleteGroup",
    ]);

    const identity = createCanonicalIdentityService({
      visibleIds: resultGroups,
      allocateAt: () => "2026-04-06T00:00:00.000Z",
    });
    const canonicalId = identity.getCanonicalId({
      info: {
        id: "host-message-001",
        role: "assistant",
      },
      parts: [
        {
          type: "text",
          text: "hello",
        },
      ],
    });
    const firstAllocation = await identity.allocateVisibleId(
      canonicalId,
      "compressible",
    );
    const secondAllocation = await identity.allocateVisibleId(
      canonicalId,
      "compressible",
    );
    assert.equal(firstAllocation.assignedVisibleId, secondAllocation.assignedVisibleId);

    const history = {
      sessionId: fixture.sessionID,
      messages: [
        {
          sequence: 1,
          canonicalId,
          role: "assistant",
          contentText: "hello",
          hostMessage: {
            info: {
              id: canonicalId,
              role: "assistant",
            },
            parts: [
              {
                type: "text",
                text: "hello",
              },
            ],
          },
        },
      ],
      marks: [],
    } satisfies ReplayedHistory;
    const projectionBuilder = createProjectionBuilder({
      historyReplayReader: createHistoryReplayReader(() => history),
      policyEngine: createFlatPolicyEngine(),
      resultGroupRepository: resultGroups,
      canonicalIdentityService: identity,
      reminderService: createStaticReminderService(),
    });
    const projection = await projectionBuilder.build({
      sessionId: fixture.sessionID,
    });
    assert.equal(projection.sessionId, fixture.sessionID);
    assert.deepEqual(projection.reminders, []);
    assert.equal(projection.state.history.messages.length, 1);
    assert.equal(projection.messages.length, 1);
    assert.equal(projection.messages[0]?.source, "canonical");
    assert.equal(
      projection.messages[0]?.contentText,
      `[${firstAllocation.assignedVisibleId}] hello`,
    );

    const scriptedTransport = createScriptedCompactionTransport([
      {
        kind: "success",
        rawPayload: {
          contentText: "compressed replacement",
        },
      },
    ]);
    const contractRunner = createContractLevelCompactionRunner({
      inputBuilder: createCompactionInputBuilder(),
      transport: createSafeTransportAdapter(scriptedTransport.transport),
      outputValidator: createOutputValidator(),
      resultGroupRepository: resultGroups,
    });
    const compactionResult = await contractRunner.run({
      build: {
        sessionId: fixture.sessionID,
        markId: "mark-contract-001",
        model: runtimeConfig.models[0] ?? "openai.right/gpt-5.4-mini",
        executionMode: "compact",
        allowDelete: false,
        promptText: await promptResolver.resolveCompactionPrompt(),
        timeoutMs: runtimeConfig.compressing.timeoutMs,
        transcript: [
          {
            role: "assistant",
            hostMessageId: "host-message-001",
            canonicalMessageId: canonicalId,
            contentText: "hello",
          },
        ],
      },
    });
    assert.equal(compactionResult.validatedOutput.contentText, "compressed replacement");

    const gate = createStaticSendEntryGate();
    const scheduler = createStaticInternalChatParamsScheduler();
    assert.deepEqual(await gate.waitIfNeeded(fixture.sessionID), {
      waited: false,
      releasedBy: "no-lock",
      reason: "no active compaction lock",
    });
    assert.deepEqual(await scheduler.scheduleIfNeeded(fixture.sessionID), {
      scheduled: false,
      reason: "scheduler contract not yet executing runtime scheduling semantics",
    });

    const evidencePath = await fixture.evidence.writeJson(
      "internal-module-contracts",
      {
        modules: CONTRACTS.map((contract) => ({
          module: contract.module,
          outboundTo: contract.dependencyDirection.outboundTo,
          mutability: contract.mutability,
        })),
        visibleId: firstAllocation.assignedVisibleId,
        projectedMessageText: projection.messages[0]?.contentText,
        compactionRequestMarkId: compactionResult.request.markID,
      },
    );
    assert.match(evidencePath, /internal-module-contracts\.json$/u);
  },
);
