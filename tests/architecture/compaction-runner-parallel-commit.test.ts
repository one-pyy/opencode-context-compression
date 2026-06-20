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
import type { RuntimeArtifactRecorder } from "../../src/runtime/runtime-artifacts.js";
import { createFileBackedRuntimeArtifactRecorder } from "../../src/runtime/runtime-artifacts.js";
import type { ResultGroupRepository } from "../../src/state/result-group-repository.js";

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
      async listPendingMarkIds() {
        return [];
      },
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
      async listPendingMarkIds() {
        return [];
      },
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
  const records: Array<{ suffix: "in" | "out"; payload: unknown }> = [];
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

test("compaction record write failure does not block compute", async () => {
  const diagnostics: Array<{ message: string; payload?: unknown }> = [];
  const runtimeArtifacts = {
    async recordEvent() {
      return;
    },
    async writeMessagesTransformSnapshot() {
      return;
    },
    async writeDiagnostic(input) {
      diagnostics.push({ message: input.message, payload: input.payload });
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

  const computation = await computeCompactionAttempt(
    dependencies,
    createRunInput("mark-records-2"),
  );

  assert.deepEqual(computation.response.rawPayload, { contentText: "model output" });
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0].message, /failed to write compaction/i);
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
    assert.deepEqual(
      parseYaml(await readFile(join(directory, files[1]), "utf8")),
      { response: true },
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

function createRuntimeConfig(input: { readonly repoRoot: string }): LoadedRuntimeConfig {
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
      maxAttemptsPerModel: 1,
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
    async listPendingMarkIds() {
      return [];
    },
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
