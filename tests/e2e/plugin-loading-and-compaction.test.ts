import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import type { CompactionRunnerTransport } from "../../src/compaction/runner.js";
import {
  loadRuntimeConfig,
  RUNTIME_CONFIG_ENV,
} from "../../src/config/runtime-config.js";
import { createChatParamsSchedulerHook } from "../../src/runtime/chat-params-scheduler.js";
import {
  readSessionFileLock,
  releaseSessionFileLock,
} from "../../src/runtime/file-lock.js";
import { waitForOrdinaryChatGateIfNeeded } from "../../src/runtime/send-entry-gate.js";
import type {
  MessagesTransformOutput,
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../../src/seams/noop-observation.js";

const PLUGIN_ENTRY =
  "/root/_/opencode/opencode-context-compression/src/index.ts";

type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type ChatParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1];

test("explicit plugin loading plus compression_mark drives the repo-owned keep route through scheduler and runner", async () => {
  await withLoadedPluginFixture(
    async ({ tempDirectory, seamLogPath, hooks }) => {
      const sessionID = "test-session";
      const e2eRuntimeConfigPath = writeE2ERuntimeConfig(tempDirectory, {
        reminderHsoft: 999_999,
        reminderHhard: 1_999_999,
        markedTokenAutoCompactionThreshold: 5_000,
      });
      const canonicalMessages = [
        createEnvelope(
          createMessage({ id: "user-1", role: "user", created: 1 }),
          [createTextPart("user-1", "hello")],
        ),
        createEnvelope(
          createMessage({ id: "assistant-1", role: "assistant", created: 2 }),
          [
            createTextPart(
              "assistant-1",
              "assistant token rich content ".repeat(3000).trim(),
            ),
          ],
        ),
        createEnvelope(
          createMessage({ id: "tool-1", role: "tool", created: 3 }),
          [
            createTextPart(
              "tool-1",
              "tool token rich output ".repeat(3000).trim(),
            ),
          ],
        ),
        createEnvelope(
          createMessage({ id: "user-2", role: "user", created: 4 }),
          [createTextPart("user-2", "next")],
        ),
      ] as const;
      const sessionHistory = createMutableSessionHistory(canonicalMessages);
      const transform = readMessagesTransformHook(hooks);
      const toolRegistry = readToolRegistry(hooks);
      const initialProjection = {
        messages: canonicalMessages.map((message) => structuredClone(message)),
      } satisfies MessagesTransformOutput;

      assert.deepEqual(Object.keys(toolRegistry).sort(), ["compression_mark"]);
      await transform({}, initialProjection);

      const compressionMark = toolRegistry.compression_mark;
      const toolOutput = await compressionMark.execute(
        {
          contractVersion: "v1",
          route: "keep",
          target: {
            startVisibleMessageID: readVisibleMessageID(
              initialProjection.messages[1],
            ),
            endVisibleMessageID: readVisibleMessageID(
              initialProjection.messages[2],
            ),
          },
        },
        createToolContext({
          tempDirectory,
          sessionID,
          messageID: "assistant-mark-call-1",
          messages: initialProjection.messages,
        }),
      );

      assert.match(toolOutput, /Persisted compression_mark/u);
      sessionHistory.push(
        createEnvelope(
          createMessage({
            id: "assistant-mark-call-1",
            role: "assistant",
            created: 5,
          }),
          [createTextPart("assistant-mark-call-1", toolOutput)],
        ),
        createEnvelope(
          createMessage({ id: "user-trigger-1", role: "user", created: 6 }),
          [createTextPart("user-trigger-1", "please continue")],
        ),
      );

      const runtimeConfig = loadRuntimeConfig({
        ...process.env,
        [RUNTIME_CONFIG_ENV.configPath]: e2eRuntimeConfigPath,
        [RUNTIME_CONFIG_ENV.runtimeLogPath]: join(
          tempDirectory,
          "runtime-events.jsonl",
        ),
        [RUNTIME_CONFIG_ENV.seamLogPath]: seamLogPath,
      });
      assert.equal(runtimeConfig.configPath, e2eRuntimeConfigPath);
      assert.match(runtimeConfig.promptPath, /prompts\/compaction\.md$/u);

      const scheduler = createChatParamsSchedulerHook({
        pluginDirectory: tempDirectory,
        client: createClientFixture(sessionHistory),
        runtimeConfig,
        runInBackground: false,
      });

      const requests: Array<{
        url: string;
        authorization?: string;
        body: unknown;
      }> = [];
      const restoreFetch = installFetchMock(async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          authorization: headers.get("authorization") ?? undefined,
          body:
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
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
        await scheduler(
          createChatParamsInput(sessionID, "user-trigger-1", {
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

      const databasePath = join(tempDirectory, "state", `${sessionID}.db`);
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT host_message_id || '|' || canonical_present FROM host_messages WHERE host_message_id = 'assistant-mark-call-1';",
        ),
        ["assistant-mark-call-1|1"],
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT allow_delete || '|' || execution_mode || '|' || status || '|' || COALESCE(content_text, '') FROM replacements ORDER BY replacement_id;",
        ),
        ["0|compact|committed|Compressed summary."],
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT mark_id || '|' || status FROM marks ORDER BY mark_id;",
        ),
        ["test-session:compression-mark:assistant-mark-call-1|consumed"],
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT status FROM compaction_batches ORDER BY batch_id;",
        ),
        ["succeeded"],
      );
      assert.equal(requests.length, 1);
      assert.equal(
        requests[0]?.url,
        "https://provider.example/v1/chat/completions",
      );
      assert.equal(requests[0]?.authorization, "Bearer test-provider-key");
      const keepRequestBody = requests[0]?.body as
        | {
            model?: string;
            temperature?: number;
            stream?: boolean;
            messages?: Array<{ role?: string; content?: string }>;
          }
        | undefined;
      assert.equal(keepRequestBody?.model, "gpt-5.4-mini");
      assert.equal(keepRequestBody?.temperature, 0);
      assert.equal(keepRequestBody?.stream, false);
      assert.equal(keepRequestBody?.messages?.[0]?.role, "system");
      assert.match(
        keepRequestBody?.messages?.[0]?.content ?? "",
        /Delete permission: \*\*allowDelete=false\*\*/u,
      );
      assert.match(
        keepRequestBody?.messages?.[0]?.content ?? "",
        /Current execution mode: \*\*executionMode=compact\*\*/u,
      );
      assert.equal(keepRequestBody?.messages?.[1]?.role, "user");
      assert.match(
        keepRequestBody?.messages?.[1]?.content ?? "",
        /Delete permission: false/u,
      );
      assert.match(
        keepRequestBody?.messages?.[1]?.content ?? "",
        /Execution mode: compact/u,
      );
      assert.match(
        keepRequestBody?.messages?.[1]?.content ?? "",
        /Source snapshot id: test-session:compression-mark:assistant-mark-call-1:snapshot/u,
      );
      assert.match(
        keepRequestBody?.messages?.[1]?.content ?? "",
        /Source fingerprint: [0-9a-f]{64}/u,
      );
      assert.match(
        keepRequestBody?.messages?.[1]?.content ?? "",
        /### 1\. assistant assistant-1 \(assistant-1\)/u,
      );
      assert.match(
        keepRequestBody?.messages?.[1]?.content ?? "",
        /### 2\. tool tool-1 \(tool-1\)/u,
      );

      const finalProjection = {
        messages: canonicalMessages.map((message) => structuredClone(message)),
      } satisfies MessagesTransformOutput;
      await transform({}, finalProjection);
      const projectedTexts = finalProjection.messages.map(readText);
      assert.equal(projectedTexts.length, 3);
      assert.match(projectedTexts[0] ?? "", /^\[protected_[^\]]+\] hello$/u);
      assert.match(
        projectedTexts[1] ?? "",
        /^\[referable_[^\]]+\] Compressed summary\.$/u,
      );
      assert.match(projectedTexts[2] ?? "", /^\[protected_[^\]]+\] next$/u);

      const observations = parseObservationLog(
        await readFile(seamLogPath, "utf8"),
      );
      assert.ok(
        observations.some((observation) =>
          observation.identityFields.some(
            (field) =>
              field.path === "pluginInit.directory" &&
              field.value === tempDirectory,
          ),
        ),
        "expected plugin init seam journal entry for the temp project directory",
      );
    },
  );
});

test("explicit plugin loading plus compression_mark commits the delete route through the same repo-owned scheduler path", async () => {
  await withLoadedPluginFixture(
    async ({ tempDirectory, seamLogPath, hooks }) => {
      const sessionID = "test-session";
      const e2eRuntimeConfigPath = writeE2ERuntimeConfig(tempDirectory, {
        reminderHsoft: 999_999,
        reminderHhard: 1_999_999,
        markedTokenAutoCompactionThreshold: 5_000,
      });
      const canonicalMessages = [
        createEnvelope(
          createMessage({ id: "user-1", role: "user", created: 1 }),
          [createTextPart("user-1", "tiny")],
        ),
        createEnvelope(
          createMessage({ id: "assistant-1", role: "assistant", created: 2 }),
          [
            createTextPart(
              "assistant-1",
              "assistant token rich content ".repeat(3000).trim(),
            ),
          ],
        ),
        createEnvelope(
          createMessage({ id: "assistant-2", role: "assistant", created: 3 }),
          [
            createTextPart(
              "assistant-2",
              "assistant tail token rich content ".repeat(3000).trim(),
            ),
          ],
        ),
      ] as const;
      const sessionHistory = createMutableSessionHistory(canonicalMessages);
      const transform = readMessagesTransformHook(hooks);
      const initialProjection = {
        messages: canonicalMessages.map((message) => structuredClone(message)),
      } satisfies MessagesTransformOutput;

      await transform({}, initialProjection);

      const toolOutput = await readToolRegistry(hooks).compression_mark.execute(
        {
          contractVersion: "v1",
          allowDelete: true,
          target: {
            startVisibleMessageID: readVisibleMessageID(
              initialProjection.messages[1],
            ),
            endVisibleMessageID: readVisibleMessageID(
              initialProjection.messages[2],
            ),
          },
        },
        createToolContext({
          tempDirectory,
          sessionID,
          messageID: "assistant-mark-call-1",
          messages: initialProjection.messages,
        }),
      );

      sessionHistory.push(
        createEnvelope(
          createMessage({
            id: "assistant-mark-call-1",
            role: "assistant",
            created: 4,
          }),
          [createTextPart("assistant-mark-call-1", toolOutput)],
        ),
        createEnvelope(
          createMessage({ id: "user-trigger-1", role: "user", created: 5 }),
          [createTextPart("user-trigger-1", "please continue")],
        ),
      );

      const scheduler = createChatParamsSchedulerHook({
        pluginDirectory: tempDirectory,
        client: createClientFixture(sessionHistory),
        runtimeConfig: loadRuntimeConfig({
          ...process.env,
          [RUNTIME_CONFIG_ENV.configPath]: e2eRuntimeConfigPath,
          [RUNTIME_CONFIG_ENV.runtimeLogPath]: join(
            tempDirectory,
            "runtime-events.jsonl",
          ),
          [RUNTIME_CONFIG_ENV.seamLogPath]: seamLogPath,
        }),
        runInBackground: false,
      });

      const requests: Array<{
        url: string;
        authorization?: string;
        body: unknown;
      }> = [];
      const restoreFetch = installFetchMock(async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          authorization: headers.get("authorization") ?? undefined,
          body:
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Deleted source span notice.",
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
        await scheduler(
          createChatParamsInput(sessionID, "user-trigger-1", {
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

      const databasePath = join(tempDirectory, "state", `${sessionID}.db`);
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT allow_delete || '|' || execution_mode || '|' || status || '|' || COALESCE(content_text, '') FROM replacements ORDER BY replacement_id;",
        ),
        ["1|delete|committed|Deleted source span notice."],
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT snapshot_kind || '|' || allow_delete || '|' || source_count FROM source_snapshots ORDER BY snapshot_kind, snapshot_id;",
        ),
        ["mark|1|2", "replacement|1|2"],
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT mark_id || '|' || status FROM marks ORDER BY mark_id;",
        ),
        ["test-session:compression-mark:assistant-mark-call-1|consumed"],
      );
      assert.equal(requests.length, 1);
      assert.equal(
        requests[0]?.url,
        "https://provider.example/v1/chat/completions",
      );
      assert.equal(requests[0]?.authorization, "Bearer test-provider-key");
      const deleteRequestBody = requests[0]?.body as
        | {
            model?: string;
            temperature?: number;
            stream?: boolean;
            messages?: Array<{ role?: string; content?: string }>;
          }
        | undefined;
      assert.equal(deleteRequestBody?.model, "gpt-5.4-mini");
      assert.equal(deleteRequestBody?.temperature, 0);
      assert.equal(deleteRequestBody?.stream, false);
      assert.equal(deleteRequestBody?.messages?.[0]?.role, "system");
      assert.match(
        deleteRequestBody?.messages?.[0]?.content ?? "",
        /Delete permission: \*\*allowDelete=true\*\*/u,
      );
      assert.match(
        deleteRequestBody?.messages?.[0]?.content ?? "",
        /Current execution mode: \*\*executionMode=delete\*\*/u,
      );
      assert.equal(deleteRequestBody?.messages?.[1]?.role, "user");
      assert.match(
        deleteRequestBody?.messages?.[1]?.content ?? "",
        /Delete permission: true/u,
      );
      assert.match(
        deleteRequestBody?.messages?.[1]?.content ?? "",
        /Execution mode: delete/u,
      );
      assert.match(
        deleteRequestBody?.messages?.[1]?.content ?? "",
        /Source snapshot id: test-session:compression-mark:assistant-mark-call-1:snapshot/u,
      );
      assert.match(
        deleteRequestBody?.messages?.[1]?.content ?? "",
        /Source fingerprint: [0-9a-f]{64}/u,
      );
      assert.match(
        deleteRequestBody?.messages?.[1]?.content ?? "",
        /### 1\. assistant assistant-1 \(assistant-1\)/u,
      );
      assert.match(
        deleteRequestBody?.messages?.[1]?.content ?? "",
        /### 2\. assistant assistant-2 \(assistant-2\)/u,
      );

      const finalProjection = {
        messages: canonicalMessages.map((message) => structuredClone(message)),
      } satisfies MessagesTransformOutput;
      await transform({}, finalProjection);
      assert.equal(finalProjection.messages.length, 2);
      assert.match(
        readText(finalProjection.messages[0]),
        /^\[protected_[^\]]+\] tiny$/u,
      );
      assert.match(
        readText(finalProjection.messages[1]),
        /^\[referable_[^\]]+\] Deleted source span notice\.$/u,
      );
    },
  );
});

test("ordinary chat waits during the running lock, unrelated tools continue, and lock-time marks join only the next batch", async () => {
  await withLoadedPluginFixture(
    async ({ tempDirectory, seamLogPath, hooks }) => {
      const sessionID = "test-session";
      const e2eRuntimeConfigPath = writeE2ERuntimeConfig(tempDirectory, {
        reminderHsoft: 999_999,
        reminderHhard: 1_999_999,
        markedTokenAutoCompactionThreshold: 5_000,
      });
      const canonicalMessages = [
        createEnvelope(
          createMessage({ id: "user-1", role: "user", created: 1 }),
          [createTextPart("user-1", "hello")],
        ),
        createEnvelope(
          createMessage({ id: "assistant-1", role: "assistant", created: 2 }),
          [
            createTextPart(
              "assistant-1",
              "assistant token rich content ".repeat(3000).trim(),
            ),
          ],
        ),
        createEnvelope(
          createMessage({ id: "tool-1", role: "tool", created: 3 }),
          [
            createTextPart(
              "tool-1",
              "tool token rich output ".repeat(3000).trim(),
            ),
          ],
        ),
        createEnvelope(
          createMessage({ id: "assistant-2", role: "assistant", created: 4 }),
          [
            createTextPart(
              "assistant-2",
              "assistant tail token rich content ".repeat(3000).trim(),
            ),
          ],
        ),
        createEnvelope(
          createMessage({ id: "user-2", role: "user", created: 5 }),
          [createTextPart("user-2", "later user ".repeat(300).trim())],
        ),
      ] as const;
      const sessionHistory = createMutableSessionHistory(canonicalMessages);
      const transform = readMessagesTransformHook(hooks);
      const toolRegistry = readToolRegistry(hooks);
      const toolExecuteBefore = readToolExecuteBeforeHook(hooks);
      const projected = {
        messages: canonicalMessages.map((message) => structuredClone(message)),
      } satisfies MessagesTransformOutput;

      await transform({}, projected);

      const firstToolOutput = await toolRegistry.compression_mark.execute(
        {
          contractVersion: "v1",
          allowDelete: false,
          target: {
            startVisibleMessageID: readVisibleMessageID(projected.messages[1]),
            endVisibleMessageID: readVisibleMessageID(projected.messages[2]),
          },
        },
        createToolContext({
          tempDirectory,
          sessionID,
          messageID: "assistant-mark-call-1",
          messages: projected.messages,
        }),
      );

      sessionHistory.push(
        createEnvelope(
          createMessage({
            id: "assistant-mark-call-1",
            role: "assistant",
            created: 6,
          }),
          [createTextPart("assistant-mark-call-1", firstToolOutput)],
        ),
        createEnvelope(
          createMessage({ id: "user-trigger-1", role: "user", created: 7 }),
          [createTextPart("user-trigger-1", "please continue")],
        ),
      );

      let releaseFirstTransport: (() => void) | undefined;
      const firstTransportBlocked = new Promise<void>((resolve) => {
        releaseFirstTransport = resolve;
      });
      const backgroundErrors: unknown[] = [];
      const runtimeConfig = loadRuntimeConfig({
        ...process.env,
        [RUNTIME_CONFIG_ENV.configPath]: e2eRuntimeConfigPath,
        [RUNTIME_CONFIG_ENV.runtimeLogPath]: join(
          tempDirectory,
          "runtime-events.jsonl",
        ),
        [RUNTIME_CONFIG_ENV.seamLogPath]: seamLogPath,
      });
      const firstScheduler = createChatParamsSchedulerHook({
        pluginDirectory: tempDirectory,
        client: createClientFixture(sessionHistory),
        runtimeConfig,
        runInBackground: true,
        transport: createSafeTransport(async (request) => {
          assert.equal(request.input.allowDelete, false);
          assert.equal(request.input.executionMode, "compact");
          assert.deepEqual(
            request.input.sourceMessages.map(
              (message) => message.hostMessageID,
            ),
            ["assistant-1", "tool-1"],
          );
          await firstTransportBlocked;
          return { contentText: "First summary." };
        }),
        onBackgroundError(error) {
          backgroundErrors.push(error);
        },
      });

      await firstScheduler(
        createChatParamsInput(sessionID, "user-trigger-1"),
        createChatParamsOutput(),
      );
      await waitForRunningLock(tempDirectory, sessionID, backgroundErrors);
      await toolExecuteBefore(
        { tool: "read", sessionID, callID: "call-read-1" },
        { args: {} },
      );

      const waitPromise = waitForOrdinaryChatGateIfNeeded({
        pluginDirectory: tempDirectory,
        sessionID,
        pollIntervalMs: 1,
      });
      const waitRace = await Promise.race([
        waitPromise.then(() => "settled"),
        delay(10).then(() => "pending"),
      ]);
      assert.equal(waitRace, "pending");

      const secondToolOutput = await toolRegistry.compression_mark.execute(
        {
          contractVersion: "v1",
          allowDelete: false,
          target: {
            startVisibleMessageID: readVisibleMessageID(projected.messages[3]),
            endVisibleMessageID: readVisibleMessageID(projected.messages[4]),
          },
        },
        createToolContext({
          tempDirectory,
          sessionID,
          messageID: "assistant-mark-call-2",
          messages: projected.messages,
        }),
      );

      sessionHistory.push(
        createEnvelope(
          createMessage({
            id: "assistant-mark-call-2",
            role: "assistant",
            created: 8,
          }),
          [createTextPart("assistant-mark-call-2", secondToolOutput)],
        ),
      );

      const databasePath = join(tempDirectory, "state", `${sessionID}.db`);
      const firstBatchID = singleValue(
        querySqlite(
          databasePath,
          "SELECT batch_id FROM compaction_batches ORDER BY frozen_at_ms;",
        ),
        "first running batch id",
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          `SELECT mark_id FROM compaction_batch_marks WHERE batch_id = '${firstBatchID}' ORDER BY member_index;`,
        ),
        ["test-session:compression-mark:assistant-mark-call-1"],
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT mark_id || '|' || status FROM marks ORDER BY mark_id;",
        ),
        [
          "test-session:compression-mark:assistant-mark-call-1|active",
          "test-session:compression-mark:assistant-mark-call-2|active",
        ],
      );

      releaseFirstTransport?.();
      const waitOutcome = await waitPromise;
      assert.deepEqual(waitOutcome, {
        outcome: "succeeded",
        source: "compaction-batch",
      });
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT mark_id || '|' || status FROM marks ORDER BY mark_id;",
        ),
        [
          "test-session:compression-mark:assistant-mark-call-1|consumed",
          "test-session:compression-mark:assistant-mark-call-2|active",
        ],
      );

      sessionHistory.push(
        createEnvelope(
          createMessage({ id: "user-trigger-2", role: "user", created: 9 }),
          [createTextPart("user-trigger-2", "please continue again")],
        ),
      );
      const secondScheduler = createChatParamsSchedulerHook({
        pluginDirectory: tempDirectory,
        client: createClientFixture(sessionHistory),
        runtimeConfig,
        runInBackground: false,
        transport: createSafeTransport(async (request) => {
          assert.equal(request.input.allowDelete, false);
          assert.equal(request.input.executionMode, "compact");
          assert.deepEqual(
            request.input.sourceMessages.map(
              (message) => message.hostMessageID,
            ),
            ["assistant-2", "user-2"],
          );
          return { contentText: "Late summary." };
        }),
      });

      await secondScheduler(
        createChatParamsInput(sessionID, "user-trigger-2"),
        createChatParamsOutput(),
      );

      const batchIDs = querySqlite(
        databasePath,
        "SELECT batch_id FROM compaction_batches ORDER BY frozen_at_ms;",
      );
      assert.equal(batchIDs.length, 2);
      assert.deepEqual(
        querySqlite(
          databasePath,
          `SELECT mark_id FROM compaction_batch_marks WHERE batch_id = '${batchIDs[1]}' ORDER BY member_index;`,
        ),
        ["test-session:compression-mark:assistant-mark-call-2"],
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT mark_id || '|' || status FROM marks ORDER BY mark_id;",
        ),
        [
          "test-session:compression-mark:assistant-mark-call-1|consumed",
          "test-session:compression-mark:assistant-mark-call-2|consumed",
        ],
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT status FROM compaction_batches ORDER BY frozen_at_ms;",
        ),
        ["succeeded", "succeeded"],
      );
      assert.deepEqual(
        querySqlite(
          databasePath,
          "SELECT COALESCE(content_text, '') FROM replacements ORDER BY committed_at_ms;",
        ),
        ["First summary.", "Late summary."],
      );
    },
  );
});

async function withLoadedPluginFixture(
  run: (fixture: {
    tempDirectory: string;
    seamLogPath: string;
    hooks: Record<string, unknown>;
  }) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "opencode-context-compression-task7-e2e-"),
  );
  const seamLogPath = join(tempDirectory, "seam-observation.jsonl");
  const runtimeLogPath = join(tempDirectory, "runtime-events.jsonl");
  const runtimeConfigPath = writeE2ERuntimeConfig(tempDirectory, {
    reminderHsoft: 999_999,
    reminderHhard: 1_999_999,
    markedTokenAutoCompactionThreshold: 5_000,
  });
  const originalSeamLogPath = process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG;
  const originalRuntimeLogPath =
    process.env.OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH;
  const originalRuntimeConfigPath =
    process.env.OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH;

  process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG = seamLogPath;
  process.env.OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH = runtimeLogPath;
  process.env.OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH =
    runtimeConfigPath;

  try {
    const pluginModule = (await import(pathToFileURL(PLUGIN_ENTRY).href)) as {
      default: (ctx: {
        directory: string;
        worktree: string;
        client: PluginInput["client"];
      }) => Promise<Record<string, unknown>>;
    };
    const hooks = await pluginModule.default({
      directory: tempDirectory,
      worktree: tempDirectory,
      client: {
        session: {},
      } as PluginInput["client"],
    });

    await run({ tempDirectory, seamLogPath, hooks });
  } finally {
    if (originalSeamLogPath === undefined) {
      delete process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG;
    } else {
      process.env.OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG = originalSeamLogPath;
    }

    if (originalRuntimeLogPath === undefined) {
      delete process.env.OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH;
    } else {
      process.env.OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH =
        originalRuntimeLogPath;
    }

    if (originalRuntimeConfigPath === undefined) {
      delete process.env.OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH;
    } else {
      process.env.OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH =
        originalRuntimeConfigPath;
    }

    await releaseSessionFileLock({
      lockDirectory: join(tempDirectory, "locks"),
      sessionID: "test-session",
    });
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function readMessagesTransformHook(hooks: Record<string, unknown>) {
  const transform = hooks["experimental.chat.messages.transform"] as
    | ((input: unknown, output: MessagesTransformOutput) => Promise<void>)
    | undefined;
  if (transform === undefined) {
    throw new Error(
      "experimental.chat.messages.transform hook missing from loaded plugin",
    );
  }

  return transform;
}

function readToolRegistry(hooks: Record<string, unknown>) {
  const toolRegistry = (
    hooks as {
      tool?: Record<
        string,
        { execute(args: unknown, context: unknown): Promise<string> }
      >;
    }
  ).tool;
  if (!toolRegistry || typeof toolRegistry !== "object") {
    throw new Error("tool registry missing from loaded plugin");
  }

  return toolRegistry;
}

function readToolExecuteBeforeHook(hooks: Record<string, unknown>) {
  const hook = hooks["tool.execute.before"] as
    | ((
        input: { tool: string; sessionID: string; callID: string },
        output: { args: unknown },
      ) => Promise<void>)
    | undefined;
  if (hook === undefined) {
    throw new Error("tool.execute.before hook missing from loaded plugin");
  }

  return hook;
}

function createMutableSessionHistory(
  messages: readonly TransformEnvelope[],
): TransformEnvelope[] {
  return messages.map((message) => structuredClone(message));
}

function createClientFixture(
  sessionMessages: TransformEnvelope[],
): PluginInput["client"] {
  return {
    session: {
      async messages() {
        return sessionMessages.map((message) => structuredClone(message));
      },
    },
  } as unknown as PluginInput["client"];
}

function createChatParamsInput(
  sessionID: string,
  messageID: string,
  options: {
    readonly providerInfo?: {
      readonly id?: string;
      readonly key?: string;
      readonly options?: Record<string, unknown>;
    };
  } = {},
): ChatParamsInput {
  const providerInfo = options.providerInfo;
  return {
    sessionID,
    agent: "main",
    model: {
      id: "gpt-5.4-mini",
      providerID: providerInfo?.id ?? "provider-1",
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
        id: providerInfo?.id ?? "provider-1",
        name: "Provider 1",
        source: "config",
        env: [],
        options: providerInfo?.options ?? {},
        models: {},
        ...(providerInfo?.key ? { key: providerInfo.key } : {}),
      },
      options: providerInfo?.options ?? {},
    },
    message: createMessage({
      id: messageID,
      role: "user",
      created: 999,
    }) as ChatParamsInput["message"],
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

function writeE2ERuntimeConfig(
  tempDirectory: string,
  input: {
    readonly reminderHsoft: number;
    readonly reminderHhard: number;
    readonly markedTokenAutoCompactionThreshold: number;
  },
): string {
  const configPath = join(tempDirectory, "runtime-config.e2e.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        promptPath: "prompts/compaction.md",
        compactionModels: ["openai.doro/gpt-5.4-mini"],
        markedTokenAutoCompactionThreshold:
          input.markedTokenAutoCompactionThreshold,
        smallUserMessageThreshold: 1_024,
        reminder: {
          hsoft: input.reminderHsoft,
          hhard: input.reminderHhard,
          softRepeatEveryTokens: 20_000,
          hardRepeatEveryTokens: 10_000,
          promptPaths: {
            compactOnly: {
              soft: "prompts/reminder-soft-compact-only.md",
              hard: "prompts/reminder-hard-compact-only.md",
            },
            deleteAllowed: {
              soft: "prompts/reminder-soft-delete-allowed.md",
              hard: "prompts/reminder-hard-delete-allowed.md",
            },
          },
        },
        logging: { level: "off" },
        compressing: { timeoutSeconds: 600 },
        schedulerMarkThreshold: 1,
        runtimeLogPath: "logs/runtime-events.jsonl",
        seamLogPath: "logs/seam-observation.jsonl",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return configPath;
}

function createToolContext(input: {
  readonly tempDirectory: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly messages: readonly TransformEnvelope[];
}) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    agent: "main",
    directory: input.tempDirectory,
    worktree: input.tempDirectory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
    messages: input.messages,
  };
}

function createEnvelope(
  info: TransformMessage,
  parts: TransformPart[],
): TransformEnvelope {
  return { info, parts };
}

function createMessage(input: {
  readonly id: string;
  readonly role: string;
  readonly created: number;
}): TransformMessage {
  return {
    id: input.id,
    sessionID: "test-session",
    role: input.role,
    agent: "main",
    model: {
      providerID: "provider-1",
      modelID: "gpt-5",
    },
    time: { created: input.created },
  } as TransformMessage;
}

function createTextPart(messageID: string, text: string): TransformPart {
  return {
    id: `${messageID}:part`,
    sessionID: "test-session",
    messageID,
    type: "text",
    text,
  } as TransformPart;
}

function readVisibleMessageID(message: TransformEnvelope | undefined): string {
  const text = message ? readText(message) : undefined;
  const match =
    typeof text === "string"
      ? /^\[(?:protected|referable|compressible)_([^\]]+)\]/u.exec(text)
      : null;
  const visibleMessageID = match?.[1];
  if (typeof visibleMessageID !== "string" || visibleMessageID.length === 0) {
    throw new Error(
      `Unable to read visible message id from projected text '${String(text)}'.`,
    );
  }

  return visibleMessageID;
}

function readText(message: TransformEnvelope): string {
  const textPart = message.parts.find((part) => part.type === "text") as
    | (TransformPart & { text: string })
    | undefined;
  return textPart?.text ?? "";
}

function parseObservationLog(serialized: string): Array<{
  seam: string;
  identityFields: Array<{ path: string; value: string }>;
}> {
  return serialized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          seam: string;
          identityFields: Array<{ path: string; value: string }>;
        },
    );
}

function querySqlite(databasePath: string, query: string): string[] {
  const output = execFileSync("sqlite3", [databasePath, query], {
    encoding: "utf8",
  });

  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function singleValue(values: readonly string[], label: string): string {
  if (values.length !== 1) {
    throw new Error(
      `Expected exactly one ${label}, received ${values.length}.`,
    );
  }

  return values[0]!;
}

async function waitForRunningLock(
  pluginDirectory: string,
  sessionID: string,
  backgroundErrors: readonly unknown[],
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

  throw new Error(`Expected a running lock for session '${sessionID}'.`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
