import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import type { PluginInput } from "@opencode-ai/plugin";

import { createContractLevelCompactionRunnerImplementation, computeCompactionAttempt, commitCompactionAttempt } from "../../src/compaction/runner/internal-runner.js";
import { InvalidCompactionOutputError } from "../../src/compaction/errors.js";
import type { LoadedRuntimeConfig } from "../../src/config/runtime-config.js";
import type { InternalCompactionRunnerDependencies } from "../../src/compaction/runner.js";
import type { RunCompactionInput } from "../../src/compaction/types.js";
import type { CompactionInputBuilder } from "../../src/compaction/input-builder.js";
import type { OutputValidator } from "../../src/compaction/output-validation.js";
import type { SafeTransportAdapter } from "../../src/runtime/compaction-transport.js";
import { createDefaultRuntimePluginSeamServices } from "../../src/runtime/default-plugin-services.js";
import { executeBackgroundCompactions } from "../../src/runtime/background-compaction-executor.js";
import type { RuntimeArtifactRecorder } from "../../src/runtime/runtime-artifacts.js";
import { createFileBackedRuntimeArtifactRecorder } from "../../src/runtime/runtime-artifacts.js";
import {
  resolvePluginStateDirectory,
  resolveSessionDatabasePath,
} from "../../src/runtime/sidecar-layout.js";
import type { ResultGroupRepository } from "../../src/state/result-group-repository.js";
import { createCompactionFailureRepository } from "../../src/state/compaction-failure-repository.js";
import {
  bootstrapSessionSidecar,
  openSessionSidecarRepository,
} from "../../src/state/sidecar-store.js";
import {
  resolvePluginLockDirectory,
  resolveSessionFileLockPath,
} from "../../src/runtime/file-lock.js";
import type { ProjectedMessageSet } from "../../src/projection/types.js";
import {
  replayHistoryFromSources,
  type CanonicalHostMessage,
} from "../../src/history/history-replay-reader.js";
import { ToastService } from "../../src/services/toast-service.js";
import { CompactionTransportMalformedPayloadError } from "../../src/compaction/transport/errors.js";
import { createCanonicalIdentityService } from "../../src/identity/canonical-identity.js";
import { createFlatPolicyEngine } from "../../src/projection/policy-engine.js";
import { createProjectionBuilder } from "../../src/projection/projection-builder.js";
import { createStaticReminderService } from "../../src/projection/reminder-service.js";
import { createResultGroupRepository } from "../../src/state/result-group-repository.js";

test("delete containment conflicts rewrite accepted mark results and never retry in the background", async (t) => {
  const pluginDirectory = await mkdtemp(join(tmpdir(), "retired-mark-replay-"));
  const sessionId = `retired-mark-${Date.now()}`;
  const databasePath = resolveSessionDatabasePath(resolvePluginStateDirectory(pluginDirectory), sessionId);
  t.after(async () => {
    await rm(pluginDirectory, { recursive: true, force: true });
    await rm(databasePath, { force: true });
  });
  await bootstrapSessionSidecar({ databasePath });
  const sidecar = await openSessionSidecarRepository({ databasePath });
  t.after(() => sidecar.close());
  const resultGroups = createResultGroupRepository(sidecar);
  const identity = createCanonicalIdentityService({ visibleIds: resultGroups });
  const hostHistory = ["Before", "Retired original", "After", "accepted delete", "accepted compact"].map((text, i) => ({
    sequence: i + 1,
    message: { info: { id: `msg-${i + 1}`, role: "assistant" as const }, parts: [{ type: "text" as const, text }] },
  }));
  const ids = await Promise.all(hostHistory.map((entry) => identity.allocateVisibleId(entry.message.info.id, "compressible")));
  const history = replayHistoryFromSources({
    sessionId, hostHistory,
    toolHistory: [
      { sequence: 4, sourceMessageId: "msg-4", toolName: "compression_mark", input: {
        mode: "delete", from: ids[1].assignedVisibleId, to: ids[1].assignedVisibleId,
      }, result: { ok: true, markId: "retired" } },
      { sequence: 5, sourceMessageId: "msg-5", toolName: "compression_mark", input: {
        mode: "compact", from: ids[0].assignedVisibleId, to: ids[2].assignedVisibleId,
      }, result: { ok: true, markId: "invalid" } },
    ],
  });
  await resultGroups.upsertCompleteGroup({
    markId: "retired", mode: "delete", executionMode: "delete", sourceStartSeq: 2, sourceEndSeq: 2,
    createdAt: "2026-09-18T00:00:00.000Z",
    fragments: [{ sourceStartSeq: 2, sourceEndSeq: 2, replacementText: "Retained requirement" }],
  });
  const builder = createProjectionBuilder({
    historyReplayReader: { async read() { return history; } },
    policyEngine: createFlatPolicyEngine(), resultGroupRepository: resultGroups,
    canonicalIdentityService: identity, reminderService: createStaticReminderService(),
  });
  const events: string[] = [];
  for (const replacementGateOpen of [true, false]) {
    const projection = await builder.build({ sessionId, replacementGateOpen });
    assert.deepEqual(projection.state.markTree.marks.map((mark) => mark.markId), ["retired"]);
    const override = projection.toolResultOverrides.find((item) => item.sourceMessageId === "msg-5");
    assert.ok(override);
    assert.equal(JSON.parse(override.output).ok, false);
    assert.equal(JSON.parse(override.output).errorCode, "OVERLAP_CONFLICT");
    assert.match(override.output, /contains delete mark/);
    assert.match(projection.messages.find((message) => message.canonicalId === "msg-5")!.contentText, /"ok":false/);
    assert.ok(projection.messages.some((message) => message.contentText === "Retained requirement"));
    assert.ok(!projection.messages.some((message) => message.contentText.includes("Retired original")));
    await executeBackgroundCompactions({
      pluginInput: createPluginInput(pluginDirectory), sessionId, projectionState: projection,
      runtimeConfig: { ...createRuntimeConfig({ repoRoot: pluginDirectory }), transport: {
        async invoke() { events.push("unexpected-model-call"); throw new Error("must not execute"); },
      } },
      runtimeArtifacts: createFileBackedRuntimeArtifactRecorder({
        pluginDirectory, runtimeLogPath: "logs/runtime-events.jsonl", seamLogPath: "logs/seams.jsonl", loggingLevel: "off",
      }),
      toastService: createRecordingToastService(events),
    });
    await resultGroups.markApplied("retired");
  }
  assert.deepEqual(events, []);
  assert.equal(history.marks.length, 2);
  assert.equal(await resultGroups.getCompleteGroup("invalid"), null);
  assert.equal((await resultGroups.getCompleteGroup("retired"))!.fragments[0].replacementText, "Retained requirement");
});

test("compaction compute can run independently and commit remains ordered", async () => {
  const events: string[] = [];
  const releaseFirst = deferred<void>();
  const releaseSecond = deferred<void>();

  const dependencies: InternalCompactionRunnerDependencies = {
    inputBuilder: {
      async build(input) {
        return {
          sessionID: input.sessionId,
          markID: input.markId,
          model: input.model,
          executionMode: "compact",
          promptText: input.promptText,
          transcript: [],
          timeoutMs: input.timeoutMs,
        };
      },
    } as CompactionInputBuilder,
    transport: {
      async execute(request) {
        events.push(`transport:${request.markID}`);
        if (request.markID === "mark-1") {
          await releaseFirst.promise;
        } else {
          await releaseSecond.promise;
        }
        return { rawPayload: { ok: true } };
      },
    } as SafeTransportAdapter,
    outputValidator: {
      async validate({ request }) {
        return { contentText: `ok:${request.markID}` };
      },
    } as OutputValidator,
    resultGroupRepository: {
      async upsertCompleteGroup(input) {
        events.push(`commit:${input.markId}`);
      },
      async getCompleteGroup() {
        return null;
      },
      async listGroupsOverlappingRange() {
        return [];
      },
      async allocateVisibleId() {
        throw new Error("unused");
      },
      async markApplied() {},
    } as ResultGroupRepository,
  };

  const input1 = createRunInput("mark-1");
  const input2 = createRunInput("mark-2");

  const compute1 = computeCompactionAttempt(dependencies, input1);
  const compute2 = computeCompactionAttempt(dependencies, input2);

  await tick();
  assert.deepEqual(events, ["transport:mark-1", "transport:mark-2"]);

  releaseSecond.resolve();
  const computed2 = await compute2;
  await commitCompactionAttempt(
    { computation: computed2, runInput: input2 },
    dependencies,
  );
  assert.deepEqual(events.slice(-1), ["commit:mark-2"]);

  releaseFirst.resolve();
  const computed1 = await compute1;
  await commitCompactionAttempt(
    { computation: computed1, runInput: input1 },
    dependencies,
  );

  assert.deepEqual(events, [
    "transport:mark-1",
    "transport:mark-2",
    "commit:mark-2",
    "commit:mark-1",
  ]);
});

test("compaction commit rejects partial compact fragments before persisting a result group", async () => {
  let committed = false;
  const dependencies: InternalCompactionRunnerDependencies = {
    inputBuilder: {
      async build(input) {
        return {
          sessionID: input.sessionId,
          markID: input.markId,
          model: input.model,
          executionMode: "compact",
          promptText: input.promptText,
          transcript: [
            {
              sequenceNumber: 2,
              role: "user",
              hostMessageID: "msg-1",
              sourceStartSeq: 2,
              sourceEndSeq: 10,
              contentText: "first compressible window",
            },
            {
              sequenceNumber: 11,
              role: "assistant",
              hostMessageID: "msg-2",
              sourceStartSeq: 11,
              sourceEndSeq: 14,
              opaquePlaceholderSlot: "S1",
              contentText: "<opaque slot=\"S1\"/>",
            },
            {
              sequenceNumber: 15,
              role: "user",
              hostMessageID: "msg-3",
              sourceStartSeq: 15,
              sourceEndSeq: 20,
              contentText: "second compressible window",
            },
          ],
          timeoutMs: input.timeoutMs,
        };
      },
    } as CompactionInputBuilder,
    transport: {
      async execute() {
        return { rawPayload: { ok: true } };
      },
    } as SafeTransportAdapter,
    outputValidator: {
      async validate() {
        return {
          contentText:
            "<opaque slot=\"S1\"/>\n\nOnly the trailing window was summarized.",
        };
      },
    } as OutputValidator,
    resultGroupRepository: {
      async upsertCompleteGroup() {
        committed = true;
      },
      async getCompleteGroup() {
        return null;
      },
      async listGroupsOverlappingRange() {
        return [];
      },
      async allocateVisibleId() {
        throw new Error("unused");
      },
      async markApplied() {},
    } as ResultGroupRepository,
  };

  await assert.rejects(
    async () => {
      await createContractLevelCompactionRunnerImplementation(dependencies).run(
        createRunInput("mark-partial-1"),
      );
    },
    (error) => {
      assert.equal(error instanceof InvalidCompactionOutputError, true);
      assert.match(
        (error as Error).message,
        /produced no replacement text for a compressible window/i,
      );
      return true;
    },
  );

  assert.equal(committed, false);
});

test("compaction compute records model request and raw payload only", async () => {
  const records: Array<{ suffix: "in" | "out" | "err"; payload: unknown }> = [];
  const diagnostics: unknown[] = [];
  const rawPayload = { contentText: "model output", usage: { input: 1 } };

  const runtimeArtifacts = {
    async recordEvent() {
      return;
    },
    async writeMessagesTransformSnapshot() {
      return;
    },
    async writeDiagnostic(input) {
      diagnostics.push(input);
    },
    async writeCompactionRecord(input) {
      records.push({ suffix: input.suffix, payload: input.payload });
    },
  } satisfies RuntimeArtifactRecorder;

  const dependencies: InternalCompactionRunnerDependencies = {
    inputBuilder: {
      async build(input) {
        return {
          sessionID: input.sessionId,
          markID: input.markId,
          model: input.model,
          executionMode: "compact",
          promptText: input.promptText,
          transcript: [],
          timeoutMs: input.timeoutMs,
        };
      },
    } as CompactionInputBuilder,
    transport: {
      async execute() {
        return { rawPayload };
      },
    } as SafeTransportAdapter,
    outputValidator: {
      async validate() {
        return { contentText: "validated text" };
      },
    } as OutputValidator,
    resultGroupRepository: createUnusedResultGroupRepository(),
    runtimeArtifacts,
  };

  await computeCompactionAttempt(dependencies, createRunInput("mark-records-1"));

  assert.equal(diagnostics.length, 0);
  assert.deepEqual(records, [
    {
      suffix: "in",
      payload: {
        sessionID: "session-1",
        markID: "mark-records-1",
        model: "model-a",
        executionMode: "compact",
        promptText: "compress",
        transcript: [],
        timeoutMs: 1_000,
      },
    },
    { suffix: "out", payload: rawPayload },
  ]);
});

test("compaction error records preserve returned response and error", async () => {
  const records: Array<{ suffix: "in" | "out" | "err"; payload: unknown }> = [];
  const responsePayload = {
    contentText: JSON.stringify({
      plan: "Plan was generated.",
      compression_output: "Invalid because the opaque slot is missing.",
    }),
  };
  const runtimeArtifacts = {
    async recordEvent() {
      return;
    },
    async writeMessagesTransformSnapshot() {
      return;
    },
    async writeDiagnostic() {
      return;
    },
    async writeCompactionRecord(input) {
      records.push({ suffix: input.suffix, payload: input.payload });
    },
  } satisfies RuntimeArtifactRecorder;

  const dependencies: InternalCompactionRunnerDependencies = {
    inputBuilder: {
      async build(input) {
        return {
          sessionID: input.sessionId,
          markID: input.markId,
          model: input.model,
          executionMode: "compact",
          promptText: input.promptText,
          transcript: [],
          timeoutMs: input.timeoutMs,
        };
      },
    } as CompactionInputBuilder,
    transport: {
      async execute() {
        return { rawPayload: responsePayload };
      },
    } as SafeTransportAdapter,
    outputValidator: {
      async validate() {
        throw new InvalidCompactionOutputError({
          markId: "mark-error-record",
          model: "model-a",
          executionMode: "compact",
          detail: "opaque slot missing",
        });
      },
    } as OutputValidator,
    resultGroupRepository: createUnusedResultGroupRepository(),
    runtimeArtifacts,
  };

  await assert.rejects(
    () => computeCompactionAttempt(dependencies, createRunInput("mark-error-record")),
    /opaque slot missing/u,
  );

  const errorRecord = records.at(-1);
  assert.equal(errorRecord?.suffix, "err");
  assert.deepEqual(errorRecord?.payload, {
    name: "InvalidCompactionOutputError",
    message: "Invalid compaction output for mark 'mark-error-record' on model 'model-a' (compact): opaque slot missing",
    response: responsePayload,
  });
});

test("compaction error records preserve malformed response payload", async () => {
  const records: Array<{ suffix: "in" | "out" | "err"; payload: unknown }> = [];
  const responsePayload = { contentText: "not valid JSON" };
  const runtimeArtifacts = {
    async recordEvent() {
      return;
    },
    async writeMessagesTransformSnapshot() {
      return;
    },
    async writeDiagnostic() {
      return;
    },
    async writeCompactionRecord(input) {
      records.push({ suffix: input.suffix, payload: input.payload });
    },
  } satisfies RuntimeArtifactRecorder;

  const dependencies: InternalCompactionRunnerDependencies = {
    inputBuilder: {
      async build(input) {
        return {
          sessionID: input.sessionId,
          markID: input.markId,
          model: input.model,
          executionMode: "compact",
          promptText: input.promptText,
          transcript: [],
          timeoutMs: input.timeoutMs,
        };
      },
    } as CompactionInputBuilder,
    transport: {
      async execute(request) {
        throw new CompactionTransportMalformedPayloadError(
          request,
          responsePayload,
          "response is not valid JSON",
        );
      },
    } as SafeTransportAdapter,
    outputValidator: {} as OutputValidator,
    resultGroupRepository: createUnusedResultGroupRepository(),
    runtimeArtifacts,
  };

  await assert.rejects(
    () => computeCompactionAttempt(dependencies, createRunInput("mark-malformed-record")),
    /response is not valid JSON/u,
  );

  const errorRecord = records.at(-1);
  assert.equal(errorRecord?.suffix, "err");
  const errorPayload = errorRecord?.payload as {
    name: string;
    message: string;
    response: unknown;
  };
  assert.equal(errorPayload.name, "CompactionTransportMalformedPayloadError");
  assert.match(errorPayload.message, /response is not valid JSON/u);
  assert.deepEqual(errorPayload.response, responsePayload);
});

test("diagnostic write failures surface when compaction record writes fail", async () => {
  let diagnosticAttempts = 0;
  const runtimeArtifacts = {
    async recordEvent() {
      return;
    },
    async writeMessagesTransformSnapshot() {
      return;
    },
    async writeDiagnostic() {
      diagnosticAttempts += 1;
      throw new Error("diagnostic disk unavailable");
    },
    async writeCompactionRecord() {
      throw new Error("record disk unavailable");
    },
  } satisfies RuntimeArtifactRecorder;

  const dependencies: InternalCompactionRunnerDependencies = {
    inputBuilder: {
      async build(input) {
        return {
          sessionID: input.sessionId,
          markID: input.markId,
          model: input.model,
          executionMode: "compact",
          promptText: input.promptText,
          transcript: [],
          timeoutMs: input.timeoutMs,
        };
      },
    } as CompactionInputBuilder,
    transport: {
      async execute() {
        return { rawPayload: { contentText: "model output" } };
      },
    } as SafeTransportAdapter,
    outputValidator: {
      async validate() {
        return { contentText: "validated text" };
      },
    } as OutputValidator,
    resultGroupRepository: createUnusedResultGroupRepository(),
    runtimeArtifacts,
  };

  await assert.rejects(
    () => computeCompactionAttempt(dependencies, createRunInput("mark-records-2")),
    /diagnostic disk unavailable/u,
  );

  assert.equal(diagnosticAttempts, 2);
});

test("file-backed recorder writes paired compaction records with shared time prefix", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-compaction-records-"),
  );
  try {
    const recorder = createFileBackedRuntimeArtifactRecorder({
      pluginDirectory,
      runtimeLogPath: "logs/runtime-events.jsonl",
      seamLogPath: "logs/seams.jsonl",
      loggingLevel: "debug",
      now: () => "2026-05-28T10:11:12.123Z",
    });

    await recorder.writeCompactionRecord({
      sessionID: "ses_record_test",
      sourceStartSeq: 2,
      sourceEndSeq: 20,
      createdAt: "2026-05-28T10:11:12.123Z",
      suffix: "in",
      model: "openai/gpt-5.5",
      attemptIndex: 0,
      payload: { request: true },
    });
    await recorder.writeCompactionRecord({
      sessionID: "ses_record_test",
      sourceStartSeq: 2,
      sourceEndSeq: 20,
      createdAt: "2026-05-28T10:11:12.123Z",
      suffix: "out",
      model: "openai/gpt-5.5",
      attemptIndex: 0,
      payload: { response: true },
    });

    const directory = join(pluginDirectory, "logs", "compaction-records");
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, [
      "2026-05-28T10_11_12.123Z-ses_record_test-2-20-openai_gpt-5.5-attempt1.in.yaml",
      "2026-05-28T10_11_12.123Z-ses_record_test-2-20-openai_gpt-5.5-attempt1.out.yaml",
    ]);
    assert.deepEqual(
      parseYaml(await readFile(join(directory, files[0]), "utf8")),
      { request: true },
    );
    assert.match(
      await readFile(join(directory, files[0]), "utf8"),
      /^request: true\n$/,
    );
    assert.deepEqual(
      parseYaml(await readFile(join(directory, files[1]), "utf8")),
      { response: true },
    );
    assert.match(
      await readFile(join(directory, files[1]), "utf8"),
      /^response: true\n$/,
    );
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

test("default runtime services write repo-owned artifacts under runtime config repo root", async () => {
  const hostDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-host-"),
  );
  const repoRoot = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-repo-root-"),
  );
  try {
    const runtimeConfig = createRuntimeConfig({ repoRoot });
    const services = createDefaultRuntimePluginSeamServices(
      createPluginInput(hostDirectory),
      runtimeConfig,
    );

    await services.runtimeArtifacts.writeCompactionRecord({
      sessionID: "ses_repo_artifact_root",
      sourceStartSeq: 2,
      sourceEndSeq: 20,
      createdAt: "2026-05-28T10:11:12.123Z",
      suffix: "in",
      model: "openai/gpt-5.5",
      attemptIndex: 0,
      payload: { request: true },
    });

    const directory = join(repoRoot, "logs", "compaction-records");
    const files = await readdir(directory);
    assert.deepEqual(files, [
      "2026-05-28T10_11_12.123Z-ses_repo_artifact_root-2-20-openai_gpt-5.5-attempt1.in.yaml",
    ]);
    await assert.rejects(readdir(join(hostDirectory, "logs", "compaction-records")));
  } finally {
    await rm(hostDirectory, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("background compaction stops retrying at the configured failure limit", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-background-toast-failed-"),
  );
  const events: string[] = [];
  const sessionId = `session-toast-failed-${Date.now()}`;

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await executeBackgroundCompactions({
        pluginInput: createPluginInput(pluginDirectory),
        runtimeConfig: {
          ...createRuntimeConfig({ repoRoot: pluginDirectory, maxFailureCount: 3 }),
          transport: {
            async invoke(request) {
              events.push(`transport:${request.markID}`);
              throw new Error("model unavailable");
            },
          },
        },
        runtimeArtifacts: createFileBackedRuntimeArtifactRecorder({
          pluginDirectory,
          runtimeLogPath: "logs/runtime-events.jsonl",
          seamLogPath: "logs/seams.jsonl",
          loggingLevel: "off",
        }),
        sessionId,
        projectionState: createProjectedSetWithOneMark(sessionId),
        toastService: createRecordingToastService(events),
      });
    }

    const databasePath = resolveSessionDatabasePath(
      resolvePluginStateDirectory(pluginDirectory),
      sessionId,
    );
    const sidecar = await openSessionSidecarRepository({ databasePath });
    try {
      const failure = createCompactionFailureRepository(sidecar).getFailure("mark-1");
      assert.equal(failure?.failureCount, 3);
      assert.match(failure?.lastError ?? "", /model unavailable/u);
    } finally {
      sidecar.close();
    }

    await executeBackgroundCompactions({
      pluginInput: createPluginInput(pluginDirectory),
      runtimeConfig: {
        ...createRuntimeConfig({ repoRoot: pluginDirectory, maxFailureCount: 3 }),
        transport: {
          async invoke(request) {
            events.push(`unexpected-transport:${request.markID}`);
            throw new Error("terminal failure should have skipped this mark");
          },
        },
      },
      runtimeArtifacts: createFileBackedRuntimeArtifactRecorder({
        pluginDirectory,
        runtimeLogPath: "logs/runtime-events.jsonl",
        seamLogPath: "logs/seams.jsonl",
        loggingLevel: "off",
      }),
      sessionId,
      projectionState: createProjectedSetWithOneMark(sessionId),
      toastService: createRecordingToastService(events),
    });

    assert.deepEqual(events, [
      "toast:Compression Started",
      "transport:mark-1",
      "toast:Compression Failed",
      "toast:Compression Started",
      "transport:mark-1",
      "toast:Compression Failed",
      "toast:Compression Started",
      "transport:mark-1",
      "toast:Compression Failed",
    ]);
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
    await rm(
      resolveSessionDatabasePath(resolvePluginStateDirectory(pluginDirectory), sessionId),
      { force: true },
    );
  }
});

test("a successful later send clears the persisted model-chain failure count", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-background-recovery-"),
  );
  const sessionId = `session-background-recovery-${Date.now()}`;
  const databasePath = resolveSessionDatabasePath(
    resolvePluginStateDirectory(pluginDirectory),
    sessionId,
  );
  const runtimeArtifacts = createFileBackedRuntimeArtifactRecorder({
    pluginDirectory,
    runtimeLogPath: "logs/runtime-events.jsonl",
    seamLogPath: "logs/seams.jsonl",
    loggingLevel: "off",
  });

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await executeBackgroundCompactions({
        pluginInput: createPluginInput(pluginDirectory),
        runtimeConfig: {
          ...createRuntimeConfig({ repoRoot: pluginDirectory }),
          transport: {
            async invoke() {
              throw new Error("temporary model outage");
            },
          },
        },
        runtimeArtifacts,
        sessionId,
        projectionState: createProjectedSetWithOneMark(sessionId),
      });
    }

    const failedSidecar = await openSessionSidecarRepository({ databasePath });
    try {
      assert.equal(
        createCompactionFailureRepository(failedSidecar).getFailure("mark-1")
          ?.failureCount,
        3,
      );
    } finally {
      failedSidecar.close();
    }

    await executeBackgroundCompactions({
      pluginInput: createPluginInput(pluginDirectory),
      runtimeConfig: {
        ...createRuntimeConfig({ repoRoot: pluginDirectory }),
        transport: {
          async invoke() {
            return {
              contentText: JSON.stringify({
                plan: "Recover the compact summary.",
                compression_output: "Recovered compact summary.",
              }),
            };
          },
        },
      },
      runtimeArtifacts,
      sessionId,
      projectionState: createProjectedSetWithOneMark(sessionId),
    });

    const recoveredSidecar = await openSessionSidecarRepository({ databasePath });
    try {
      assert.equal(
        createCompactionFailureRepository(recoveredSidecar).getFailure("mark-1"),
        null,
      );
      const group = recoveredSidecar.database
        .prepare<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM result_groups WHERE mark_id = 'mark-1'`,
        )
        .get();
      assert.equal(group?.count, 1);
    } finally {
      recoveredSidecar.close();
    }
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
    await rm(databasePath, { force: true });
  }
});

test("terminal failure persistence errors release the lock and leave the mark retryable", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-terminal-write-failure-"),
  );
  const sessionId = `session-terminal-write-failure-${Date.now()}`;
  const databasePath = resolveSessionDatabasePath(
    resolvePluginStateDirectory(pluginDirectory),
    sessionId,
  );
  const lockPath = resolveSessionFileLockPath(
    resolvePluginLockDirectory(pluginDirectory),
    sessionId,
  );
  const events: string[] = [];

  try {
    await bootstrapSessionSidecar({ databasePath });
    const setupSidecar = await openSessionSidecarRepository({ databasePath });
    try {
      setupSidecar.database.exec(`
        CREATE TRIGGER fail_terminal_compaction_insert
        BEFORE INSERT ON compaction_failures
        BEGIN
          SELECT RAISE(FAIL, 'terminal failure persistence blocked');
        END;
      `);
    } finally {
      setupSidecar.close();
    }

    await executeBackgroundCompactions({
      pluginInput: createPluginInput(pluginDirectory),
      runtimeConfig: {
        ...createRuntimeConfig({ repoRoot: pluginDirectory }),
        transport: {
          async invoke() {
            events.push("failed-attempt");
            throw new Error("model unavailable");
          },
        },
      },
      runtimeArtifacts: createFileBackedRuntimeArtifactRecorder({
        pluginDirectory,
        runtimeLogPath: "logs/runtime-events.jsonl",
        seamLogPath: "logs/seams.jsonl",
        loggingLevel: "off",
      }),
      sessionId,
      projectionState: createProjectedSetWithOneMark(sessionId),
    });

    const failedSidecar = await openSessionSidecarRepository({ databasePath });
    try {
      assert.equal(
        createCompactionFailureRepository(failedSidecar).getFailure("mark-1"),
        null,
      );
      failedSidecar.database.exec(`DROP TRIGGER fail_terminal_compaction_insert`);
    } finally {
      failedSidecar.close();
    }
    await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });

    await executeBackgroundCompactions({
      pluginInput: createPluginInput(pluginDirectory),
      runtimeConfig: {
        ...createRuntimeConfig({ repoRoot: pluginDirectory }),
        transport: {
          async invoke() {
            events.push("recovery-attempt");
            return {
              contentText: JSON.stringify({
                plan: "Recover the summary.",
                compression_output: "Recovered summary.",
              }),
            };
          },
        },
      },
      runtimeArtifacts: createFileBackedRuntimeArtifactRecorder({
        pluginDirectory,
        runtimeLogPath: "logs/runtime-events.jsonl",
        seamLogPath: "logs/seams.jsonl",
        loggingLevel: "off",
      }),
      sessionId,
      projectionState: createProjectedSetWithOneMark(sessionId),
    });

    const recoveredSidecar = await openSessionSidecarRepository({ databasePath });
    try {
      const row = recoveredSidecar.database
        .prepare<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM result_groups WHERE mark_id = 'mark-1'`,
        )
        .get();
      assert.equal(row?.count, 1);
    } finally {
      recoveredSidecar.close();
    }
    assert.deepEqual(events, [
      "failed-attempt",
      "recovery-attempt",
    ]);
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
    await rm(databasePath, { force: true });
  }
});

test("background compaction skips child marks when the parent already has a result group", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-covered-child-"),
  );
  const events: string[] = [];

  try {
    await executeBackgroundCompactions({
      pluginInput: createPluginInput(pluginDirectory),
      runtimeConfig: {
        ...createRuntimeConfig({ repoRoot: pluginDirectory }),
        transport: {
          async invoke(request) {
            events.push(`transport:${request.markID}`);
            throw new Error("covered child should not be compressed");
          },
        },
      },
      runtimeArtifacts: createFileBackedRuntimeArtifactRecorder({
        pluginDirectory,
        runtimeLogPath: "logs/runtime-events.jsonl",
        seamLogPath: "logs/seams.jsonl",
        loggingLevel: "off",
      }),
      sessionId: "session-covered-child",
      projectionState: createProjectedSetWithCompressedParentAndChildMark(
        "session-covered-child",
      ),
    });

    assert.deepEqual(events, []);
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

function createRunInput(markId: string): RunCompactionInput {
  return {
    build: {
      sessionId: "session-1",
      markId,
      model: "model-a",
      executionMode: "compact",
      promptText: "compress",
      transcript: [],
      timeoutMs: 1_000,
    },
  };
}

function createProjectedSetWithOneMark(sessionId: string): ProjectedMessageSet {
  const message = {
    info: { id: "msg-1", role: "assistant" },
    parts: [{ type: "text", text: "Compress this message." }],
  } satisfies CanonicalHostMessage;
  const history = replayHistoryFromSources({
    sessionId,
    hostHistory: [{ sequence: 1, message }],
    toolHistory: [],
  });
  const state: ProjectedMessageSet["state"] = {
    sessionId,
    history,
    markTree: {
      conflicts: [],
      marks: [
        {
          markId: "mark-1",
          mode: "compact",
          startVisibleMessageId: "compressible_000001_aa",
          endVisibleMessageId: "compressible_000001_aa",
          sourceMessageId: "mark-tool-1",
          sourceSequence: 2,
          startSequence: 1,
          endSequence: 1,
          depth: 0,
          children: [],
        },
      ],
    },
    conflicts: [],
    messagePolicies: [
      {
        canonicalId: "msg-1",
        sequence: 1,
        role: "assistant",
        visibleKind: "compressible",
        tokenCount: 10,
        visibleId: "compressible_000001_aa",
        visibleSeq: 1,
        visibleBase62: "aa",
      },
    ],
    visibleIdAllocations: [],
    resultGroups: [],
    failedToolMessageIds: new Map(),
  };

  return {
    sessionId,
    messages: [],
    toolResultOverrides: [],
    reminders: [],
    conflicts: [],
    state,
  };
}

function createProjectedSetWithCompressedParentAndChildMark(
  sessionId: string,
): ProjectedMessageSet {
  const projected = createProjectedSetWithOneMark(sessionId);
  const parentMark = {
    ...projected.state.markTree.marks[0]!,
    markId: "parent-mark",
    sourceMessageId: "parent-mark-tool",
    children: [
      {
        ...projected.state.markTree.marks[0]!,
        markId: "child-mark",
        sourceMessageId: "child-mark-tool",
        children: [],
      },
    ],
  };

  return {
    ...projected,
    state: {
      ...projected.state,
      markTree: {
        conflicts: [],
        marks: [parentMark],
      },
      resultGroups: [
        {
          markId: "parent-mark",
          mode: "compact",
          sourceStartSeq: 1,
          sourceEndSeq: 1,
          fragmentCount: 1,
          executionMode: "compact",
          createdAt: "2026-07-04T00:00:00.000Z",
          payloadSha256: "test-parent",
          applied: false,
          fragments: [
            {
              fragmentIndex: 0,
              sourceStartSeq: 1,
              sourceEndSeq: 1,
              replacementText: "parent summary",
            },
          ],
        },
      ],
    },
  };
}

function createRecordingToastService(events: string[]): ToastService {
  return new ToastService(
    {
      directory: "",
      worktree: "",
      client: {
        tui: {
          async showToast(request: { readonly body: { readonly title: string } }) {
            events.push(`toast:${request.body.title}`);
          },
        },
      },
    } as unknown as PluginInput,
    { enabled: true },
  );
}

function createRuntimeConfig(input: {
  readonly repoRoot: string;
  readonly maxFailureCount?: number;
}): LoadedRuntimeConfig {
  return {
    repoRoot: input.repoRoot,
    configPath: join(input.repoRoot, "runtime-config.jsonc"),
    allowDelete: false,
    promptPath: join(input.repoRoot, "prompts", "compaction.md"),
    promptText: "compress",
    leadingUserPromptPath: join(input.repoRoot, "prompts", "leading-user.md"),
    leadingUserPromptText: "",
    models: ["model-a"],
    markedTokenAutoCompactionThreshold: 1,
    idleThresholdMs: 300_000,
    smallUserMessageThreshold: 1,
    schedulerMarkThreshold: 1,
    runtimeLogPath: "logs/runtime-events.jsonl",
    seamLogPath: "logs/seams.jsonl",
    logging: { level: "debug" },
    compressing: {
      timeoutSeconds: 1,
      timeoutMs: 1_000,
      firstTokenTimeoutSeconds: 1,
      firstTokenTimeoutMs: 1_000,
      streamIdleTimeoutSeconds: 1,
      streamIdleTimeoutMs: 1_000,
      maxFailureCount: input.maxFailureCount ?? 99_999,
    },
    reminder: {
      hsoft: 1,
      hhard: 2,
      softRepeatEveryTokens: 1,
      hardRepeatEveryTokens: 1,
      promptPaths: {
        compactOnly: {
          soft: join(input.repoRoot, "prompts", "soft.md"),
          hard: join(input.repoRoot, "prompts", "hard.md"),
        },
        deleteAllowed: {
          soft: join(input.repoRoot, "prompts", "delete-soft.md"),
          hard: join(input.repoRoot, "prompts", "delete-hard.md"),
        },
      },
      prompts: {
        compactOnly: {
          soft: { path: join(input.repoRoot, "prompts", "soft.md"), text: "soft" },
          hard: { path: join(input.repoRoot, "prompts", "hard.md"), text: "hard" },
        },
        deleteAllowed: {
          soft: { path: join(input.repoRoot, "prompts", "delete-soft.md"), text: "soft" },
          hard: { path: join(input.repoRoot, "prompts", "delete-hard.md"), text: "hard" },
        },
      },
    },
    toast: {
      enabled: false,
      durations: {
        startup: 0,
        softReminder: 0,
        hardReminder: 0,
        compressionStart: 0,
        compressionComplete: 0,
        compressionFailed: 0,
      },
    },
  } satisfies LoadedRuntimeConfig;
}

function createPluginInput(directory: string): PluginInput {
  return {
    directory,
    worktree: directory,
    client: {
      session: {
        async messages() {
          return { data: [] };
        },
      },
    },
  } as unknown as PluginInput;
}

function createUnusedResultGroupRepository(): ResultGroupRepository {
  return {
    async upsertCompleteGroup() {
      throw new Error("unused");
    },
    async getCompleteGroup() {
      return null;
    },
    async listGroupsOverlappingRange() {
      return [];
    },
    async allocateVisibleId() {
      throw new Error("unused");
    },
    async markApplied() {},
  } as ResultGroupRepository;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
