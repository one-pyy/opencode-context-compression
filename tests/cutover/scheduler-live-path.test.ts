import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { createChatParamsSchedulerHook } from "../../src/runtime/chat-params-scheduler.js";
import {
  readSessionFileLock,
  releaseSessionFileLock,
} from "../../src/runtime/file-lock.js";
import { createRuntimeEventWriter } from "../../src/runtime/runtime-events.js";
import { waitForOrdinaryChatGateIfNeeded } from "../../src/runtime/send-entry-gate.js";
import { persistMark } from "../../src/marks/mark-service.js";
import {
  createSqliteSessionStateStore,
  type SqliteSessionStateStore,
} from "../../src/state/store.js";
import type { CompactionRunnerTransport } from "../../src/compaction/runner.js";
import type { RuntimeConfig } from "../../src/config/runtime-config.js";
import {
  findProductionCallSites,
  formatAuditHits,
  readRepoFile,
} from "./cutover-test-helpers.js";
import { OpencodeContextCompressionTokenEstimationError } from "../../src/token-estimation.js";

type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type ChatParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1];
type PluginClient = PluginInput["client"];

test("live plugin wiring reaches repo-owned mark persistence and compaction runner paths", async () => {
  const entrypointSource = await readRepoFile("src/index.ts");
  const persistMarkCallSites = await findProductionCallSites("persistMark", {
    excludeFiles: ["src/marks/mark-service.ts"],
  });
  const runCompactionBatchCallSites = await findProductionCallSites(
    "runCompactionBatch",
    {
      excludeFiles: ["src/compaction/runner.ts"],
    },
  );
  const gaps: string[] = [];

  if (!entrypointSource.includes('hooks["chat.params"]')) {
    gaps.push(
      '`src/index.ts` never overrides `hooks["chat.params"]`, so the live plugin entrypoint still returns the noop observation seam instead of a repo-owned scheduler hook.',
    );
  }

  if (persistMarkCallSites.length === 0) {
    gaps.push(
      "No production caller reaches `persistMark()` outside its own definition, so mark persistence is still internal-only.",
    );
  }

  if (runCompactionBatchCallSites.length === 0) {
    gaps.push(
      "No production caller reaches `runCompactionBatch()` outside its own definition, so the compaction runner still has no live runtime caller path.",
    );
  }

  if (gaps.length > 0) {
    assert.fail(
      [
        "Cutover gap: no live scheduler caller path reaches the repo-owned mark/runner flow yet.",
        ...gaps.map((gap) => `- ${gap}`),
        formatAuditHits(
          "persistMark production callsites",
          persistMarkCallSites,
        ),
        formatAuditHits(
          "runCompactionBatch production callsites",
          runCompactionBatchCallSites,
        ),
      ].join("\n"),
    );
  }
});

test("scheduler reaches batch freeze and runner", async () => {
  await withSchedulerEnvironment(
    async ({
      pluginDirectory,
      store,
      clock,
      runtimeConfig,
      sessionMessages,
    }) => {
      seedMarkedSession(store, clock);
      const seenRequests: Array<{
        model: string;
        promptText: string;
        hostMessageIDs: string[];
      }> = [];
      const hook = createChatParamsSchedulerHook({
        pluginDirectory,
        client: createClientFixture(sessionMessages),
        runtimeConfig,
        runInBackground: false,
        now: () => clock.tick(),
        transport: createSafeTransport(async (request) => {
          seenRequests.push({
            model: request.model,
            promptText: request.input.promptText,
            hostMessageIDs: request.input.sourceMessages.map(
              (message) => message.hostMessageID,
            ),
          });
          return { contentText: "Compressed summary." };
        }),
      });

      await hook(
        createChatParamsInput(store.sessionID, "user-trigger-1"),
        createChatParamsOutput(),
      );

      const activeMarks = store.listMarks({ status: "active" });
      assert.deepEqual(activeMarks, []);
      assert.equal(store.listMarks().at(0)?.status, "consumed");

      const batchID =
        store.findLatestCommittedReplacementForMark("mark-1")?.batchID;
      assert.equal(typeof batchID, "string");
      if (typeof batchID !== "string") {
        assert.fail(
          "expected scheduler-triggered replacement to record its batch ID",
        );
      }

      const batches = store.listCompactionBatchMarks(batchID);
      assert.equal(batches.length, 1);
      assert.equal(store.getCompactionBatch(batchID)?.status, "succeeded");
      assert.equal(
          store.findLatestCommittedReplacementForMark("mark-1")?.contentText,
        "Compressed summary.",
      );
      assert.deepEqual(seenRequests, [
        {
          model: runtimeConfig.models[0],
          promptText: runtimeConfig.promptText,
          hostMessageIDs: ["assistant-1", "tool-1"],
        },
      ]);
    },
  );
});

test("scheduler waits for marked-token readiness before running compaction", async () => {
  await withSchedulerEnvironment(
    async ({
      pluginDirectory,
      store,
      clock,
      runtimeConfig,
      sessionMessages,
    }) => {
      seedMarkedSession(store, clock);

      const belowThresholdHook = createChatParamsSchedulerHook({
        pluginDirectory,
        client: createClientFixture(sessionMessages),
        runtimeConfig: {
          ...runtimeConfig,
          markedTokenAutoCompactionThreshold: 8,
        },
        runInBackground: false,
        now: () => clock.tick(),
        transport: createSafeTransport(async () => {
          throw new Error(
            "scheduler should not invoke transport before marked-token threshold is met",
          );
        }),
      });

      await belowThresholdHook(
        createChatParamsInput(store.sessionID, "user-trigger-1"),
        createChatParamsOutput(),
      );

      assert.equal(
          store.findLatestCommittedReplacementForMark("mark-1"),
        undefined,
      );

      const atThresholdHook = createChatParamsSchedulerHook({
        pluginDirectory,
        client: createClientFixture(sessionMessages),
        runtimeConfig: {
          ...runtimeConfig,
          markedTokenAutoCompactionThreshold: 7,
        },
        runInBackground: false,
        now: () => clock.tick(),
        transport: createSafeTransport(async () => ({
          contentText: "Compressed summary.",
        })),
      });

      await atThresholdHook(
        createChatParamsInput(store.sessionID, "user-trigger-2"),
        createChatParamsOutput(),
      );

      assert.equal(
          store.findLatestCommittedReplacementForMark("mark-1")?.contentText,
        "Compressed summary.",
      );
    },
  );
});

test("default scheduler transport executes through the plugin-owned runtime executor", async () => {
  await withSchedulerEnvironment(
    async ({
      pluginDirectory,
      store,
      clock,
      runtimeConfig,
      sessionMessages,
    }) => {
      seedMarkedSession(store, clock);
      const requests: Array<{
        url: string;
        authorization?: string;
        body: unknown;
      }> = [];
      const hook = createChatParamsSchedulerHook({
        pluginDirectory,
        client: createClientFixture(sessionMessages),
        runtimeConfig,
        runInBackground: false,
        now: () => clock.tick(),
      });

      const restoreFetch = installFetchMock(async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const headers = new Headers(init?.headers);
        const bodyText = typeof init?.body === "string" ? init.body : "";
        requests.push({
          url,
          authorization: headers.get("authorization") ?? undefined,
          body: bodyText.length > 0 ? JSON.parse(bodyText) : undefined,
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Compressed summary.",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

      try {
        await hook(
          createChatParamsInput(store.sessionID, "user-trigger-1", {
            providerInfo: {
              id: "openai.doro",
              key: "test-provider-key",
              options: {
                baseURL: "https://provider.example/v1",
              },
            },
          }),
          createChatParamsOutput(),
        );
      } finally {
        restoreFetch();
      }

      assert.equal(
          store.findLatestCommittedReplacementForMark("mark-1")?.contentText,
        "Compressed summary.",
      );
      assert.equal(requests.length, 1);
      assert.equal(
        requests[0]?.url,
        "https://provider.example/v1/chat/completions",
      );
      assert.equal(requests[0]?.authorization, "Bearer test-provider-key");
      const requestBody = requests[0]?.body as
        | {
            model?: string;
            temperature?: number;
            stream?: boolean;
            messages?: Array<{ role?: string; content?: string }>;
          }
        | undefined;
      assert.equal(requestBody?.model, "gpt-5.4-mini");
      assert.equal(requestBody?.temperature, 0);
      assert.equal(requestBody?.stream, false);
      assert.equal(requestBody?.messages?.[0]?.role, "system");
      assert.match(
        requestBody?.messages?.[0]?.content ?? "",
        /Repo-owned compaction prompt/u,
      );
      assert.match(
        requestBody?.messages?.[0]?.content ?? "",
        /Delete permission: \*\*allowDelete=false\*\*/u,
      );
      assert.match(
        requestBody?.messages?.[0]?.content ?? "",
        /Current execution mode: \*\*executionMode=compact\*\*/u,
      );
      assert.equal(requestBody?.messages?.[1]?.role, "user");
      assert.match(
        requestBody?.messages?.[1]?.content ?? "",
        /Source snapshot id: mark-1:snapshot/u,
      );
      assert.match(
        requestBody?.messages?.[1]?.content ?? "",
        /Source fingerprint: [0-9a-f]{64}/u,
      );
      assert.match(
        requestBody?.messages?.[1]?.content ?? "",
        /Canonical revision: rev-\d+/u,
      );
      assert.match(
        requestBody?.messages?.[1]?.content ?? "",
        /### 1\. assistant assistant-1 \(assistant-1\)/u,
      );
      assert.match(
        requestBody?.messages?.[1]?.content ?? "",
        /### 2\. tool tool-1 \(tool-1\)/u,
      );
      assert.match(
        requestBody?.messages?.[1]?.content ?? "",
        /Canonical transcript:/u,
      );
      assert.match(
        requestBody?.messages?.[1]?.content ?? "",
        /Return only the final committed replacement text\. Do not return JSON, markdown fences, labels, or commentary\./u,
      );
    },
  );
});

test("send-entry gate remains the wait authority", async () => {
  await withSchedulerEnvironment(
    async ({
      pluginDirectory,
      store,
      clock,
      runtimeConfig,
      sessionMessages,
    }) => {
      seedMarkedSession(store, clock);
      let releaseTransport: (() => void) | undefined;
      const backgroundErrors: unknown[] = [];
      const transportStarted = new Promise<void>((resolve) => {
        releaseTransport = resolve;
      });
      const hook = createChatParamsSchedulerHook({
        pluginDirectory,
        client: createClientFixture(sessionMessages),
        runtimeConfig,
        runInBackground: true,
        now: () => clock.tick(),
        transport: createSafeTransport(async () => {
          await transportStarted;
          return { contentText: "Compressed summary." };
        }),
        onBackgroundError(error) {
          backgroundErrors.push(error);
        },
      });

      await hook(
        createChatParamsInput(store.sessionID, "user-trigger-2"),
        createChatParamsOutput(),
      );

      await waitForRunningLock(
        pluginDirectory,
        store.sessionID,
        backgroundErrors,
      );

      const waitPromise = waitForOrdinaryChatGateIfNeeded({
        pluginDirectory,
        sessionID: store.sessionID,
        pollIntervalMs: 1,
      });
      const raceOutcome = await Promise.race([
        waitPromise.then(() => "settled"),
        delay(10).then(() => "pending"),
      ]);

      assert.equal(raceOutcome, "pending");
      releaseTransport?.();
      const waitOutcome = await waitPromise;
      assert.deepEqual(waitOutcome, {
        outcome: "succeeded",
        source: "compaction-batch",
      });
    },
  );
});

test("default chat.params scheduler path returns before transport completion", async () => {
  await withSchedulerEnvironment(
    async ({
      pluginDirectory,
      store,
      clock,
      runtimeConfig,
      sessionMessages,
    }) => {
      seedMarkedSession(store, clock);
      let releaseTransport: (() => void) | undefined;
      let transportStarted = false;
      const backgroundErrors: unknown[] = [];
      const transportBlocked = new Promise<void>((resolve) => {
        releaseTransport = resolve;
      });
      const hook = createChatParamsSchedulerHook({
        pluginDirectory,
        client: createClientFixture(sessionMessages),
        runtimeConfig,
        now: () => clock.tick(),
        transport: createSafeTransport(async () => {
          transportStarted = true;
          await transportBlocked;
          return { contentText: "Compressed summary." };
        }),
        onBackgroundError(error) {
          backgroundErrors.push(error);
        },
      });

      const hookResult = await Promise.race([
        hook(
          createChatParamsInput(store.sessionID, "user-trigger-2"),
          createChatParamsOutput(),
        ).then(() => "returned"),
        delay(10).then(() => "blocked"),
      ]);

      assert.equal(hookResult, "returned");
      await waitForRunningLock(
        pluginDirectory,
        store.sessionID,
        backgroundErrors,
      );
      assert.equal(transportStarted, true);

      releaseTransport?.();
      await waitForSchedulerResult(store, backgroundErrors);
      assert.equal(
          store.findLatestCommittedReplacementForMark("mark-1")?.contentText,
        "Compressed summary.",
      );
    },
  );
});

test("scheduler ignores explicit tokenCount metadata when tokenizer-based text stays below marked-token threshold", async () => {
  await withSchedulerEnvironment(
    async ({ pluginDirectory, store, clock, runtimeConfig }) => {
      seedMarkedSession(store, clock, {
        assistantText: "short draft",
        toolText: "short tool",
        assistantTokenCount: 50_000,
        toolTokenCount: 50_000,
      });

      const hook = createChatParamsSchedulerHook({
        pluginDirectory,
        client: createClientFixture(
          createSessionMessagesFixture({
            assistantText: "short draft",
            toolText: "short tool",
            assistantTokenCount: 50_000,
            toolTokenCount: 50_000,
          }),
        ),
        runtimeConfig,
        runInBackground: false,
        now: () => clock.tick(),
        transport: createSafeTransport(async () => {
          throw new Error(
            "scheduler should not trust explicit tokenCount metadata over tokenizer-based text",
          );
        }),
      });

      await hook(
        createChatParamsInput(store.sessionID, "user-trigger-1"),
        createChatParamsOutput(),
      );

      assert.equal(
          store.findLatestCommittedReplacementForMark("mark-1"),
        undefined,
      );
      assert.equal(store.listMarks({ status: "active" }).length, 1);
    },
  );
});

test("scheduler tokenization fails fast instead of using heuristic threshold guesses", async () => {
  await withSchedulerEnvironment(
    async ({
      pluginDirectory,
      store,
      clock,
      runtimeConfig,
      sessionMessages,
    }) => {
      seedMarkedSession(store, clock, {
        assistantText: "token rich content",
        toolText: "token rich output",
      });

      const hook = createChatParamsSchedulerHook({
        pluginDirectory,
        client: createClientFixture(sessionMessages),
        runtimeConfig: {
          ...runtimeConfig,
          models: ["unsupported-threshold-model"],
          markedTokenAutoCompactionThreshold: 1,
        },
        runInBackground: false,
        now: () => clock.tick(),
        transport: createSafeTransport(async () => ({
          contentText: "Compressed summary.",
        })),
      });

      await assert.rejects(
        () =>
          hook(
            createChatParamsInput(store.sessionID, "user-trigger-1"),
            createChatParamsOutput(),
          ),
        (error: unknown) => {
          assert.ok(
            error instanceof OpencodeContextCompressionTokenEstimationError,
          );
          assert.match(String(error), /Unsupported tokenizer model/u);
          return true;
        },
      );
    },
  );
});

test("runtime event writer respects logging levels for runtime gate observations", async () => {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-runtime-events-"),
  );
  const logPath = join(pluginDirectory, "logs", "runtime-events.jsonl");
  const observed = {
    observationID: "obs-1",
    gateName: "compressing" as const,
    authority: "file-lock" as const,
    observedState: "running" as const,
    lockPath: join(pluginDirectory, "locks", "session.lock"),
    observedAtMs: 1,
    startedAtMs: 1,
    settledAtMs: undefined,
    activeJobCount: 1,
    note: "runtime event",
    metadata: undefined,
  };

  try {
    createRuntimeEventWriter({
      filePath: logPath,
      level: "off",
    }).recordRuntimeGateObservation(
      {
        observationID: observed.observationID,
        observedState: observed.observedState,
      },
      observed,
    );
    await assert.rejects(() => readFile(logPath, "utf8"));

    createRuntimeEventWriter({
      filePath: logPath,
      level: "error",
    }).recordRuntimeGateObservation(
      {
        observationID: "obs-2",
        observedState: "running",
      },
      {
        ...observed,
        observationID: "obs-2",
      },
    );
    await assert.rejects(() => readFile(logPath, "utf8"));

    createRuntimeEventWriter({
      filePath: logPath,
      level: "error",
    }).recordRuntimeGateObservation(
      {
        observationID: "obs-3",
        observedState: "failed",
      },
      {
        ...observed,
        observationID: "obs-3",
        observedState: "failed",
      },
    );
    const errorLog = await readFile(logPath, "utf8");
    assert.match(errorLog, /"observationID":"obs-3"/u);
    assert.doesNotMatch(errorLog, /"observationID":"obs-2"/u);

    createRuntimeEventWriter({
      filePath: logPath,
      level: "debug",
    }).recordRuntimeGateObservation(
      {
        observationID: "obs-4",
        observedState: "running",
      },
      {
        ...observed,
        observationID: "obs-4",
      },
    );
    const debugLog = await readFile(logPath, "utf8");
    assert.match(debugLog, /"observationID":"obs-4"/u);
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

async function withSchedulerEnvironment(
  run: (context: {
    pluginDirectory: string;
    store: SqliteSessionStateStore;
    clock: ReturnType<typeof createClock>;
    runtimeConfig: RuntimeConfig;
    sessionMessages: ReturnType<typeof createSessionMessagesFixture>;
  }) => Promise<void>,
): Promise<void> {
  const pluginDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-scheduler-cutover-"),
  );
  const clock = createClock();
  const store = createSqliteSessionStateStore({
    pluginDirectory,
    sessionID: "test-session",
    now: () => clock.current,
  });
  const sessionMessages = createSessionMessagesFixture();

  try {
    await run({
      pluginDirectory,
      store,
      clock,
      runtimeConfig: createRuntimeConfigFixture(),
      sessionMessages,
    });
  } finally {
    await releaseSessionFileLock({
      lockDirectory: join(pluginDirectory, "locks"),
      sessionID: store.sessionID,
    });
    store.close();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}

function seedMarkedSession(
  store: SqliteSessionStateStore,
  clock: ReturnType<typeof createClock>,
  fixtureOptions?: Parameters<typeof createSessionMessagesFixture>[0],
): void {
  const sessionMessages = createSessionMessagesFixture(fixtureOptions);
  store.syncCanonicalHostMessages({
    revision: `rev-${clock.tick()}`,
    syncedAtMs: clock.current,
    messages: sessionMessages.map((message) => ({
      hostMessageID: message.info.id,
      canonicalMessageID: message.info.id,
      role: message.info.role,
      hostCreatedAtMs: message.info.time.created,
    })),
  });
  persistMark({
    store,
    markID: "mark-1",
    toolCallMessageID: "mark-tool-1",
    allowDelete: false,
    createdAtMs: clock.tick(),
    sourceMessages: [
      { hostMessageID: "assistant-1" },
      { hostMessageID: "tool-1" },
    ],
  });
}

function createRuntimeConfigFixture(): RuntimeConfig {
  return {
    repoRoot: "/tmp/opencode-context-compression-test",
    configPath: "/tmp/opencode-context-compression-test/runtime-config.json",
    promptPath: "/tmp/opencode-context-compression-test/prompts/compaction.md",
    promptText: "Repo-owned compaction prompt.",
    models: ["openai.doro/gpt-5.4-mini"],
    markedTokenAutoCompactionThreshold: 20_000,
    smallUserMessageThreshold: 1_024,
    reminder: {
      hsoft: 12,
      hhard: 24,
      softRepeatEveryTokens: 20_000,
      hardRepeatEveryTokens: 10_000,
      prompts: {
        compactOnly: {
          soft: {
            path: "/tmp/opencode-context-compression-test/prompts/reminder-soft-compact-only.md",
            text: "Soft compact-only reminder.",
          },
          hard: {
            path: "/tmp/opencode-context-compression-test/prompts/reminder-hard-compact-only.md",
            text: "Hard compact-only reminder.",
          },
        },
        deleteAllowed: {
          soft: {
            path: "/tmp/opencode-context-compression-test/prompts/reminder-soft-delete-allowed.md",
            text: "Soft delete-allowed reminder.",
          },
          hard: {
            path: "/tmp/opencode-context-compression-test/prompts/reminder-hard-delete-allowed.md",
            text: "Hard delete-allowed reminder.",
          },
        },
      },
    },
    logging: {
      level: "off",
    },
    compressing: {
      timeoutSeconds: 600,
      timeoutMs: 600_000,
    },
    schedulerMarkThreshold: 1,
    runtimeLogPath:
      "/tmp/opencode-context-compression-test/runtime-events.jsonl",
    seamLogPath:
      "/tmp/opencode-context-compression-test/seam-observation.jsonl",
  };
}

function createClientFixture(
  sessionMessages: ReturnType<typeof createSessionMessagesFixture>,
): PluginClient {
  return {
    session: {
      async messages() {
        return sessionMessages.map((message) => structuredClone(message));
      },
    },
  } as unknown as PluginClient;
}

function createSessionMessagesFixture(options?: {
  readonly assistantText?: string;
  readonly toolText?: string;
  readonly assistantTokenCount?: number;
  readonly toolTokenCount?: number;
}) {
  const defaultAssistantText = "assistant token rich content "
    .repeat(3000)
    .trim();
  const defaultToolText = "tool token rich output ".repeat(3000).trim();
  return [
    createEnvelope(
      createMessage({ id: "assistant-1", role: "assistant", created: 1 }),
      [
        createTextPart(
          "assistant-1",
          options?.assistantText ?? defaultAssistantText,
          options?.assistantTokenCount ?? 12_000,
        ),
      ],
    ),
    createEnvelope(createMessage({ id: "tool-1", role: "tool", created: 2 }), [
      createTextPart(
        "tool-1",
        options?.toolText ?? defaultToolText,
        options?.toolTokenCount ?? 11_000,
      ),
    ]),
    createEnvelope(
      createMessage({ id: "mark-tool-1", role: "tool", created: 3 }),
      [createTextPart("mark-tool-1", "mark: assistant-1~tool-1")],
    ),
    createEnvelope(
      createMessage({ id: "user-trigger-1", role: "user", created: 4 }),
      [createTextPart("user-trigger-1", "please continue")],
    ),
    createEnvelope(
      createMessage({ id: "user-trigger-2", role: "user", created: 5 }),
      [createTextPart("user-trigger-2", "please continue again")],
    ),
  ] as const;
}

function createChatParamsInput(
  sessionID: string,
  messageID: string,
): ChatParamsInput;
function createChatParamsInput(
  sessionID: string,
  messageID: string,
  options: {
    readonly providerInfo?: {
      readonly id?: string;
      readonly key?: string;
      readonly options?: Record<string, unknown>;
    };
  },
): ChatParamsInput;
function createChatParamsInput(
  sessionID: string,
  messageID: string,
  options?: {
    readonly providerInfo?: {
      readonly id?: string;
      readonly key?: string;
      readonly options?: Record<string, unknown>;
    };
  },
): ChatParamsInput {
  const resolvedOptions = options ?? {};
  return {
    sessionID,
    agent: "main",
    model: {
      id: "gpt-5.4-mini",
      providerID: resolvedOptions.providerInfo?.id ?? "provider-1",
      api: {
        id: "gpt-5.4-mini",
        url: "https://example.test/provider/v1",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "Model Primary",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
      },
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      limit: {
        context: 100000,
        output: 4096,
      },
      status: "active" as const,
      options: {},
      headers: {},
    },
    provider: {
      source: "config",
      info: {
        id: resolvedOptions.providerInfo?.id ?? "provider-1",
        name: "Provider 1",
        source: "config",
        env: [],
        options: resolvedOptions.providerInfo?.options ?? {},
        models: {},
        ...(resolvedOptions.providerInfo?.key
          ? { key: resolvedOptions.providerInfo.key }
          : {}),
      },
      options: resolvedOptions.providerInfo?.options ?? {},
    },
    message: createUserMessage(messageID),
  };
}

function createChatParamsOutput(): ChatParamsOutput {
  return {
    temperature: 0,
    topP: 1,
    topK: 0,
    options: {},
  };
}

function createSafeTransport(
  invoke: NonNullable<CompactionRunnerTransport["invoke"]>,
): CompactionRunnerTransport {
  return {
    candidate: {
      id: "plugin.compaction.invoke",
      owner: "plugin",
      entrypoint: "independent-model-call",
      promptContext: "dedicated-compaction-prompt",
      sessionEffects: {
        createsUserMessage: false,
        reusesSharedLoop: false,
        dependsOnBusyState: false,
        mutatesPermissions: false,
      },
      failureClassification: "deterministic",
    },
    invoke,
  };
}

function installFetchMock(
  mock: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function createEnvelope(
  info: ReturnType<typeof createMessage>,
  parts: ReturnType<typeof createTextPart>[],
) {
  return { info, parts };
}

function createMessage(input: {
  readonly id: string;
  readonly role: string;
  readonly created: number;
}) {
  return {
    id: input.id,
    sessionID: "test-session",
    role: input.role,
    agent: "main",
    model: {
      providerID: "provider-1",
      modelID: "gpt-5.4-mini",
    },
    time: { created: input.created },
  };
}

function createUserMessage(messageID: string): ChatParamsInput["message"] {
  return createMessage({
    id: messageID,
    role: "user",
    created: 6,
  }) as ChatParamsInput["message"];
}

function createTextPart(messageID: string, text: string, tokenCount?: number) {
  return {
    id: `${messageID}:part`,
    sessionID: "test-session",
    messageID,
    type: "text",
    text,
    ...(tokenCount === undefined ? {} : { tokenCount }),
  };
}

function createClock() {
  let current = Date.now();

  return {
    get current() {
      return current;
    },
    tick() {
      current += 1;
      return current;
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForRunningLock(
  pluginDirectory: string,
  sessionID: string,
  backgroundErrors: readonly unknown[] = [],
): Promise<void> {
  const lockDirectory = join(pluginDirectory, "locks");

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (backgroundErrors.length > 0) {
      const [firstError] = backgroundErrors;
      throw firstError instanceof Error
        ? firstError
        : new Error(String(firstError));
    }

    const state = await readSessionFileLock({
      lockDirectory,
      sessionID,
    });
    if (state.kind === "running") {
      return;
    }

    await delay(2);
  }

  throw new Error(
    `Expected scheduler to create a running lock for session '${sessionID}'.`,
  );
}

async function waitForSchedulerResult(
  store: SqliteSessionStateStore,
  backgroundErrors: readonly unknown[] = [],
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (backgroundErrors.length > 0) {
      const [firstError] = backgroundErrors;
      throw firstError instanceof Error
        ? firstError
        : new Error(String(firstError));
    }

        if (store.findLatestCommittedReplacementForMark("mark-1") !== undefined) {
      return;
    }

    await delay(2);
  }

  throw new Error(
    "Expected scheduler activity to commit a replacement for mark-1.",
  );
}
