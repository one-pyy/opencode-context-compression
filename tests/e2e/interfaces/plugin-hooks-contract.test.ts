import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import pluginModule from "../../../src/index.js";
import { loadRuntimeConfig, resolveRuntimeConfigRepoRoot } from "../../../src/config/runtime-config.js";
import { createDefaultRuntimePluginSeamServices } from "../../../src/runtime/default-plugin-services.js";
import {
  ALLOWED_PLUGIN_EXTERNAL_HOOKS,
  ALLOWED_PLUGIN_EXTERNAL_TOOLS,
  createContextCompressionHooks,
} from "../../../src/runtime/plugin-hooks.js";
import {
  CHAT_PARAMS_EXTERNAL_CONTRACT,
  createInternalChatParamsScheduler,
} from "../../../src/runtime/chat-params-scheduler.js";
import {
  MESSAGES_TRANSFORM_EXTERNAL_CONTRACT,
  createMessagesTransformHook,
} from "../../../src/runtime/messages-transform.js";
import { stripLeadingVisibleMessageId } from "../../../src/runtime/text-complete.js";
import {
  TOOL_EXECUTE_BEFORE_EXTERNAL_CONTRACT,
} from "../../../src/runtime/send-entry-gate.js";
import { acquireSessionFileLock } from "../../../src/runtime/file-lock.js";
import { ToastService } from "../../../src/services/toast-service.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "plugin exposes only the locked external hooks and context compression tools",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "plugin hooks contract",
    });

    const hooks = createContextCompressionHooks();
    assert.deepEqual(
      Object.keys(hooks).sort(),
      [...ALLOWED_PLUGIN_EXTERNAL_HOOKS, "tool"].sort(),
    );
    assert.deepEqual(
      Object.keys(hooks.tool ?? {}).sort(),
      [...ALLOWED_PLUGIN_EXTERNAL_TOOLS].sort(),
    );

    assert.equal(
      MESSAGES_TRANSFORM_EXTERNAL_CONTRACT.relationToRuntime.scheduler,
      "read-only relative to scheduler and never dispatches jobs",
    );
    assert.equal(
      CHAT_PARAMS_EXTERNAL_CONTRACT.relationToRuntime.replay,
      "does not replay or materialize transcript state",
    );
    assert.equal(
      TOOL_EXECUTE_BEFORE_EXTERNAL_CONTRACT.visibleSideEffects[0],
      "non-DCP tools bypass",
    );

    const repoRoot = fixture.repoRoot;
    const pluginHooks = await pluginModule.server(createPluginInput(repoRoot));
    assert.deepEqual(
      Object.keys(pluginHooks).sort(),
      [...ALLOWED_PLUGIN_EXTERNAL_HOOKS, "tool"].sort(),
    );
    assert.deepEqual(
      Object.keys(pluginHooks.tool ?? {}).sort(),
      [...ALLOWED_PLUGIN_EXTERNAL_TOOLS].sort(),
    );

    const indexSource = await readFile(join(repoRoot, "src", "index.ts"), "utf8");

    const evidencePath = await fixture.evidence.writeJson("plugin-hooks-contract", {
      exposedHookKeys: Object.keys(pluginHooks).sort(),
      exposedToolKeys: Object.keys(pluginHooks.tool ?? {}).sort(),
      indexLineCount: indexSource.split(/\r?\n/u).length,
    });
    assert.match(evidencePath, /plugin-hooks-contract\.json$/u);
  },
);

test("plugin entry exports a server function for host plugin loading", async () => {
  const entry = await import("../../../src/index.js");

  assert.equal(typeof entry.default, "object");
  assert.equal(entry.default?.id, "opencode-context-compression");
  assert.equal(typeof entry.default?.server, "function");
  assert.equal(typeof entry.server, "function");
  assert.equal(entry.server, entry.default?.server);
});

test("messages.transform mutates the provided output array in place", async () => {
  const hook = createMessagesTransformHook({
    projector: {
      project() {
        return [
          {
            info: createUserMessage({ id: "msg-user-2" }),
            parts: [
              createTextPart({
                messageID: "msg-user-2",
                id: "part-user-2",
                text: "Reprojected message.",
              }),
            ],
          },
        ];
      },
    },
  });

  const output = {
    messages: [
      {
        info: createUserMessage({ id: "msg-user-1" }),
        parts: [
          createTextPart({
            messageID: "msg-user-1",
            id: "part-user-1",
            text: "Original message.",
          }),
        ],
      },
    ],
  };
  const originalArray = output.messages;

  await hook({}, output);

  assert.equal(output.messages, originalArray);
  assert.equal(output.messages.length, 1);
  assert.equal(output.messages[0]?.info.id, "msg-user-2");
  assert.equal(output.messages[0]?.parts[0]?.type, "text");
});

test("messages.transform shows compression start toast before waiting and failed toast after lock failure", async () => {
  const lockRoot = await mkdtemp(join(tmpdir(), "opencode-context-compression-lock-toast-"));
  const lockDirectory = join(lockRoot, "locks");
  const sessionID = "session-lock-toast";
  const events: string[] = [];

  try {
    const acquired = await acquireSessionFileLock({
      lockDirectory,
      sessionID,
    });
    assert.equal(acquired.acquired, true);

    const hooks = createContextCompressionHooks({
      lockDirectory,
      toastService: createRecordingToastService(events),
      sendEntryGate: {
        async waitIfNeeded() {
          events.push("gate:wait");
          return {
            waited: true,
            releasedBy: "lock-failed",
            reason: "active compaction lock reached a terminal failure state",
          };
        },
      },
      messagesTransformProjector: {
        project({ currentMessages }) {
          return currentMessages;
        },
      },
    });

    const output = {
      messages: [
        {
          info: createUserMessage({ id: "msg-user-lock-toast" }),
          parts: [
            createTextPart({
              messageID: "msg-user-lock-toast",
              id: "part-user-lock-toast",
              text: "Original message.",
            }),
          ],
        },
      ],
    };

    await hooks["experimental.chat.messages.transform"]?.({ sessionID }, output);

    assert.deepEqual(events, [
      "toast:Compression Started",
      "gate:wait",
      "toast:Compression Failed",
    ]);
  } finally {
    await rm(lockRoot, { recursive: true, force: true });
  }
});

test("text.complete strips a leading visible msg_id from assistant output", () => {
  assert.equal(
    stripLeadingVisibleMessageId("[compressible_000123_AbCDe123] Assistant answer."),
    "Assistant answer.",
  );
  assert.equal(
    stripLeadingVisibleMessageId("No prefix here."),
    "No prefix here.",
  );
});

test("chat.params keeps scheduler metadata out of provider options", async () => {
  const events: unknown[] = [];
  const hooks = createContextCompressionHooks({
    chatParamsScheduler: {
      schedule() {
        return {
          metadata: {
            schedulerState: "eligible",
            scheduled: false,
            reason: "test metadata must stay internal",
            activeCompactionLock: false,
            pendingMarkCount: 1,
          },
        };
      },
    },
    runtimeArtifacts: {
      async recordEvent(input) {
        events.push(input.payload);
      },
      async writeMessagesTransformSnapshot() {},
      async writeDiagnostic() {},
      async writeCompactionRecord() {},
    },
  });

  const output = {
    temperature: 1,
    topP: 1,
    topK: 0,
    maxOutputTokens: undefined,
    options: {},
  };

  await hooks["chat.params"]?.(
    {
      sessionID: "session-chat-params-metadata",
      agent: "build",
      model: createChatParamsModel(),
      provider: createChatParamsProvider(),
      message: createUserMessage({ id: "msg-user-chat-params" }),
    },
    output,
  );

  assert.deepEqual(output.options, {});
  assert.equal((events[0] as { reason?: string } | undefined)?.reason, "test metadata must stay internal");
});

test("production chat.params skips history evaluation and preserves provider parameters across sessions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-chat-params-lightweight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let historyReads = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("chat.params must not request token estimates");
  });
  const input = {
    ...createPluginInput(directory),
    client: {
      session: {
        async messages() {
          historyReads += 1;
          throw new Error("chat.params must not read session history");
        },
      },
    } as unknown as PluginInput["client"],
  };
  const runtimeConfig = await loadRuntimeConfig({
    OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH:
      join(resolveRuntimeConfigRepoRoot(), "src/config/runtime-config.jsonc"),
  });
  const services = createDefaultRuntimePluginSeamServices(input, runtimeConfig);
  const events: unknown[] = [];
  const hooks = createContextCompressionHooks({
    ...services,
    runtimeArtifacts: {
      async recordEvent(event) { events.push(event.payload); },
      async writeMessagesTransformSnapshot() {},
      async writeDiagnostic() {},
      async writeCompactionRecord() {},
    },
  });

  for (const sessionID of ["session-a", "session-b", "session-a"]) {
    const output = {
      temperature: 0.5,
      topP: 0.9,
      topK: 0,
      maxOutputTokens: 4096,
      options: { reasoningEffort: "medium" },
    };
    const expected = structuredClone(output);
    await hooks["chat.params"]?.({
      sessionID,
      agent: "build",
      model: createChatParamsModel(),
      provider: createChatParamsProvider(),
      message: createUserMessage({ id: `msg-${sessionID}` }),
    }, output);
    assert.deepEqual(output, expected);
  }

  assert.equal(historyReads, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal((event as { evaluationPerformed?: boolean }).evaluationPerformed, false);
    assert.match((event as { reason: string }).reason, /evaluation skipped/u);
  }
});

test("disabled seam observation skips scanning while all hooks still execute", async () => {
  let scanned = 0;
  const events: string[] = [];
  const hooks = createContextCompressionHooks({
    messagesTransformProjector: {
      project({ currentMessages }) {
        events.push("projection");
        return currentMessages;
      },
    },
    runtimeArtifacts: {
      async recordEvent(input) { events.push(input.seam); },
      async writeMessagesTransformSnapshot() {},
      async writeDiagnostic() {},
      async writeCompactionRecord() {},
    },
  });
  const markScanned = (output: object) => Object.defineProperty(output, "observationSentinel", {
    enumerable: true,
    get() { scanned += 1; return "observation-only"; },
  });
  const transformOutput = { messages: [{
    info: createUserMessage({ id: "disabled-observation" }),
    parts: [createTextPart({ id: "part-disabled", messageID: "disabled-observation", text: "test" })],
  }] };
  const originalMessages = transformOutput.messages;
  markScanned(transformOutput);
  await hooks["experimental.chat.messages.transform"]?.({ sessionID: "disabled-observation" }, transformOutput);
  assert.equal(transformOutput.messages, originalMessages);
  const paramsOutput = { temperature: 1, topP: 1, topK: 0, maxOutputTokens: undefined, options: { retained: true } };
  markScanned(paramsOutput);
  await hooks["chat.params"]?.({
    sessionID: "disabled-observation", agent: "build", model: createChatParamsModel(),
    provider: createChatParamsProvider(), message: createUserMessage({ id: "disabled-params" }),
  }, paramsOutput);
  assert.deepEqual(paramsOutput.options, { retained: true });
  const toolOutput = { args: { path: "test" } };
  markScanned(toolOutput);
  await hooks["tool.execute.before"]?.({ sessionID: "disabled-observation", tool: "read", callID: "disabled-tool" }, toolOutput);
  assert.equal(scanned, 0);
  assert.deepEqual(events, ["projection", "experimental.chat.messages.transform", "chat.params", "tool.execute.before"]);
});

test("enabled seam observation preserves ordered JSONL records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "seam-observation-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seamLogPath = join(directory, "seams.jsonl");
  const hooks = createContextCompressionHooks({ seamLogPath });
  await hooks["experimental.chat.messages.transform"]?.({ sessionID: "enabled-observation" }, { messages: [{
    info: createUserMessage({ id: "enabled-message" }),
    parts: [createTextPart({ id: "enabled-part", messageID: "enabled-message", text: "test" })],
  }] });
  await hooks["chat.params"]?.({
    sessionID: "enabled-observation", agent: "build", model: createChatParamsModel(),
    provider: createChatParamsProvider(), message: createUserMessage({ id: "enabled-params" }),
  }, { temperature: 1, topP: 1, topK: 0, options: {} });
  await hooks["tool.execute.before"]?.({ sessionID: "enabled-observation", tool: "read", callID: "enabled-tool" }, { args: {} });
  const entries = (await readFile(seamLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    sequence: number; seam: string; outputShape: { kind: string }; identityFields: Array<{ path: string; value: string }>;
  });
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2, 3]);
  assert.deepEqual(entries.map((entry) => entry.seam), ["experimental.chat.messages.transform", "chat.params", "tool.execute.before"]);
  assert.ok(entries.every((entry) => entry.outputShape.kind === "object"));
  assert.ok(entries[0]?.identityFields.some((field) => field.value === "enabled-part"));
  assert.ok(entries[1]?.identityFields.some((field) => field.value === "enabled-params"));
  assert.ok(entries[2]?.identityFields.some((field) => field.value === "enabled-tool"));
});

test("chat.params scheduler metadata includes mark eligibility diagnostics", async () => {
  const scheduler = createInternalChatParamsScheduler({
    evaluate() {
      return {
        activeCompactionLock: false,
        eligibleMarkIds: [],
        uncompressedMarkedTokenCount: 0,
        markedTokenAutoCompactionThreshold: 50_000,
        diagnostics: {
          replayedMarkCount: 1,
          replayedMarkIds: ["mark_missing_visible_id"],
          markTreeNodeCount: 0,
          markTreeMarkIds: [],
          markTreeConflicts: [
            {
              markId: "mark_missing_visible_id",
              errorCode: "OVERLAP_CONFLICT",
              message:
                "Mark targets an unknown or reversed visible-id range and is excluded from the coverage tree. Mark endpoints must resolve to a host message or to a referable range marker of a current compression result.",
            },
          ],
          queuedMarkIdsBeforeThreshold: [],
          committedResultGroupMarkIds: [],
          uncompressedMarkedTokenCount: 0,
          markedTokenAutoCompactionThreshold: 50_000,
          schedulerMarkThreshold: 1,
          usedCanonicalIdentityService: false,
          visibleIdSamples: [
            {
              canonicalId: "msg-user-1",
              visibleId: "protected_000001_ab",
            },
          ],
        },
      };
    },
  });

  const decision = await scheduler.scheduleIfNeeded("ses-diagnostics");

  assert.equal(decision.metadata?.diagnostics?.replayedMarkCount, 1);
  assert.deepEqual(decision.metadata?.diagnostics?.replayedMarkIds, [
    "mark_missing_visible_id",
  ]);
  assert.equal(decision.metadata?.diagnostics?.markTreeNodeCount, 0);
  assert.equal(
    decision.metadata?.diagnostics?.markTreeConflicts[0]?.markId,
    "mark_missing_visible_id",
  );
  assert.equal(
    decision.metadata?.diagnostics?.usedCanonicalIdentityService,
    false,
  );
});

function createPluginInput(repoRoot: string): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: repoRoot,
    worktree: repoRoot,
    serverUrl: new URL("http://localhost:3900"),
    $: {} as PluginInput["$"],
  };
}

function createRecordingToastService(events: string[]): ToastService {
  return new ToastService(
    {
      client: {
        tui: {
          async showToast(request: { readonly body: { readonly title: string } }) {
            events.push(`toast:${request.body.title}`);
          },
        },
      },
      directory: "",
      worktree: "",
    } as unknown as PluginInput,
    { enabled: true },
  );
}

function createUserMessage(overrides: { readonly id: string }) {
  return {
    id: overrides.id,
    sessionID: "session-plugin-contract",
    role: "user" as const,
    time: { created: 1 },
    agent: "atlas",
    model: {
      providerID: "openai.right",
      modelID: "gpt-5.4-mini",
    },
  };
}

type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];

function createChatParamsModel(): ChatParamsInput["model"] {
  return {
    id: "gpt-5.4-mini",
    providerID: "openai.right",
    api: { id: "openai", name: "OpenAI", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
    name: "GPT 5.4 Mini",
    mode: "chat",
    options: {},
    headers: {},
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
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 16_000 },
    status: "active",
  } as ChatParamsInput["model"];
}

function createChatParamsProvider(): ChatParamsInput["provider"] {
  return {
    source: "custom",
    info: { id: "openai.right", name: "OpenAI Right" },
    options: {},
  } as ChatParamsInput["provider"];
}

function createTextPart(input: {
  readonly id: string;
  readonly messageID: string;
  readonly text: string;
}) {
  return {
    id: input.id,
    sessionID: "session-plugin-contract",
    messageID: input.messageID,
    type: "text" as const,
    text: input.text,
  };
}
