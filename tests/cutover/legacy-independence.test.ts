import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import type { CompactionRunnerTransport } from "../../src/compaction/runner.js";
import { loadRuntimeConfig, RUNTIME_CONFIG_ENV } from "../../src/config/runtime-config.js";
import { createCompressionMarkTool } from "../../src/tools/compression-mark.js";
import { createMessagesTransformHook } from "../../src/projection/messages-transform.js";
import { createChatParamsSchedulerHook } from "../../src/runtime/chat-params-scheduler.js";
import { createSqliteSessionStateStore } from "../../src/state/store.js";
import type {
  MessagesTransformOutput,
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../../src/seams/noop-observation.js";
import {
  CANONICAL_CONTRACT_FILES,
  collectAuditHits,
  formatAuditHits,
  listRepoFiles,
} from "./cutover-test-helpers.js";

type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type ChatParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1];

const LEGACY_PROVIDER_DCP_FIELDS = Object.freeze([
  "dcpBackendContext",
  "dcpTailGuidance",
  "dcpDecision",
  "dcpQueuedCompactionRequests",
  "dcpHostAlerts",
] as const);

test("canonical plugin contract is free of legacy DCP tool names and old runtime config references", async () => {
  const hits = await collectAuditHits(CANONICAL_CONTRACT_FILES, [
    {
      pattern: /\bdcp_execute_compaction\b/u,
      reason: "old public executor tool name remains in the canonical plugin contract",
    },
    {
      pattern: /\bdcp_mark_for_compaction\b/u,
      reason: "old public mark tool name remains in the canonical plugin contract",
    },
    {
      pattern: /\bdcp_mark\b/u,
      reason: "legacy public mark alias remains in the canonical plugin contract",
    },
    {
      pattern: /config\/dcp-runtime\.json/u,
      reason: "old runtime config path remains in the canonical plugin contract",
    },
  ]);

  if (hits.length > 0) {
    assert.fail(
      [
        "Cutover gap: canonical plugin entrypoints and docs still depend on legacy DCP names or ownership references.",
        formatAuditHits("Forbidden legacy references", hits),
      ].join("\n"),
    );
  }
});

test("production plugin source does not depend on legacy provider DCP field names", async () => {
  const productionSourceFiles = (await listRepoFiles("src")).filter((filePath) => filePath.endsWith(".ts"));
  const hits = await collectAuditHits(
    productionSourceFiles,
    LEGACY_PROVIDER_DCP_FIELDS.map((fieldName) => ({
      pattern: new RegExp(`\\b${fieldName}\\b`, "u"),
      reason: `legacy provider field '${fieldName}' appears in production plugin source`,
    })),
  );

  if (hits.length > 0) {
    assert.fail(
      [
        "Cutover gap: production plugin source reintroduced a dependency on legacy provider-side DCP payload fields.",
        formatAuditHits("Forbidden provider field references", hits),
      ].join("\n"),
    );
  }
});

test("canonical execution does not require old provider DCP fields", async () => {
  const pluginDirectory = await mkdtemp(join(tmpdir(), "opencode-context-compression-provider-independence-"));
  const sessionID = "test-session";
  const canonicalMessages = [
    createEnvelope(createMessage({ id: "user-1", role: "user", created: 1 }), [
      createTextPart("user-1", "hello"),
    ]),
    createEnvelope(createMessage({ id: "assistant-1", role: "assistant", created: 2 }), [
      createTextPart("assistant-1", "draft"),
    ]),
    createEnvelope(createMessage({ id: "tool-1", role: "tool", created: 3 }), [
      createTextPart("tool-1", "tool output"),
    ]),
  ] as const;
  const sessionHistory = [
    ...canonicalMessages,
    createEnvelope(createMessage({ id: "assistant-mark-call-1", role: "assistant", created: 4 }), [
      createTextPart("assistant-mark-call-1", "Persisted compression_mark test-session:compression-mark:assistant-mark-call-1."),
    ]),
    createEnvelope(createMessage({ id: "user-trigger-1", role: "user", created: 5 }), [
      createTextPart("user-trigger-1", "please continue"),
    ]),
  ] as const;
  const runtimeConfig = loadRuntimeConfig({
    ...process.env,
    [RUNTIME_CONFIG_ENV.runtimeLogPath]: join(pluginDirectory, "runtime-events.jsonl"),
    [RUNTIME_CONFIG_ENV.seamLogPath]: join(pluginDirectory, "seam-observation.jsonl"),
  });
  const transform = createMessagesTransformHook({
    pluginDirectory,
  });
  const compressionMark = createCompressionMarkTool({
    pluginDirectory,
  });
  const scheduler = createChatParamsSchedulerHook({
    pluginDirectory,
    client: createClientFixture(sessionHistory),
    runtimeConfig,
    runInBackground: false,
    transport: createSafeTransport(async () => ({
      contentText: "Compressed summary.",
    })),
  });

  try {
    const initialProjection = {
      messages: canonicalMessages.map((message) => structuredClone(message)),
    } satisfies MessagesTransformOutput;
    await transform({}, initialProjection);

    const projectedMessages = initialProjection.messages;
    const startVisibleMessageID = readVisibleMessageID(projectedMessages[1]);
    const endVisibleMessageID = readVisibleMessageID(projectedMessages[2]);

    const toolOutput = await compressionMark.execute(
      {
        contractVersion: "v1",
        route: "keep",
        target: {
          startVisibleMessageID,
          endVisibleMessageID,
        },
      },
      createToolContext({
        pluginDirectory,
        sessionID,
        messageID: "assistant-mark-call-1",
        messages: projectedMessages,
      }),
    );
    assert.match(toolOutput, /Persisted compression_mark/u);

    const chatParamsOutput = createChatParamsOutput();
    await scheduler(createChatParamsInput(sessionID, "user-trigger-1"), chatParamsOutput);
    assertNoLegacyProviderFields(chatParamsOutput.options);

    const store = createSqliteSessionStateStore({
      pluginDirectory,
      sessionID,
    });

    try {
      const replacement = store.findFirstCommittedReplacementForMark(
        "test-session:compression-mark:assistant-mark-call-1",
      );
      assert.equal(replacement?.contentText, "Compressed summary.");
      assert.equal(store.getMarkByToolCallMessageID("assistant-mark-call-1")?.status, "consumed");
    } finally {
      store.close();
    }

    const finalProjection = {
      messages: canonicalMessages.map((message) => structuredClone(message)),
    } satisfies MessagesTransformOutput;
    await transform({}, finalProjection);

    const projectedTexts = finalProjection.messages.map(readText);
    assert.ok(
      projectedTexts.some((text) => /^\[referable_[^\]]+\] Compressed summary\.$/u.test(text)),
      `expected projected messages to include the committed replacement, received: ${projectedTexts.join(" | ")}`,
    );
  } finally {
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

function assertNoLegacyProviderFields(options: Record<string, unknown>): void {
  for (const fieldName of LEGACY_PROVIDER_DCP_FIELDS) {
    assert.equal(
      fieldName in options,
      false,
      `chat.params output unexpectedly authored legacy provider field '${fieldName}' into output.options`,
    );
  }
  assert.deepEqual(options, {});
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

function createClientFixture(sessionMessages: readonly TransformEnvelope[]): PluginInput["client"] {
  return {
    session: {
      async messages() {
        return sessionMessages.map((message) => structuredClone(message));
      },
    },
  } as unknown as PluginInput["client"];
}

function createChatParamsInput(sessionID: string, messageID: string): ChatParamsInput {
  return {
    sessionID,
    agent: "main",
    model: {
      id: "model-primary",
      providerID: "provider-1",
      api: {
        id: "provider-api",
        url: "https://example.test/provider",
        npm: "@ai-sdk/test",
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
        id: "provider-1",
        name: "Provider 1",
        source: "config",
        env: [],
        options: {},
        models: {},
      },
      options: {},
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

function createToolContext(input: {
  readonly pluginDirectory: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly messages: readonly TransformEnvelope[];
}) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    agent: "main",
    directory: input.pluginDirectory,
    worktree: input.pluginDirectory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
    messages: input.messages,
  };
}

function createEnvelope(info: TransformMessage, parts: TransformPart[]): TransformEnvelope {
  return {
    info,
    parts,
  };
}

function createMessage(input: { readonly id: string; readonly role: string; readonly created: number }): TransformMessage {
  return {
    id: input.id,
    sessionID: "test-session",
    role: input.role,
    agent: "main",
    model: {
      providerID: "provider-1",
      modelID: "model-primary",
    },
    time: { created: input.created },
  } as TransformMessage;
}

function createUserMessage(messageID: string): ChatParamsInput["message"] {
  return createMessage({ id: messageID, role: "user", created: 6 }) as ChatParamsInput["message"];
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

function readText(message: TransformEnvelope): string {
  const textPart = message.parts.find(
    (part) => part.type === "text" && typeof (part as TransformPart & { text?: unknown }).text === "string",
  );
  return typeof (textPart as (TransformPart & { text?: unknown }) | undefined)?.text === "string"
    ? ((textPart as TransformPart & { text: string }).text ?? "")
    : "";
}

function readVisibleMessageID(message: TransformEnvelope | undefined): string {
  const text = message ? readText(message) : undefined;
  const match = typeof text === "string" ? /^\[(?:protected|referable|compressible)_([^\]]+)\]/u.exec(text) : null;
  const visibleMessageID = match?.[1];
  if (typeof visibleMessageID !== "string" || visibleMessageID.length === 0) {
    throw new Error(`Unable to read visible message id from projected text '${String(text)}'.`);
  }

  return visibleMessageID;
}
