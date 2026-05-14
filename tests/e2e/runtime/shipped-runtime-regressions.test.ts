import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PluginInput } from "@opencode-ai/plugin";
import type { Message, Part } from "@opencode-ai/sdk";

import pluginModule from "../../../src/index.js";
import {
  RUNTIME_CONFIG_ENV,
} from "../../../src/config/runtime-config.js";
import {
  deserializeCompressionMarkResult,
} from "../../../src/tools/compression-mark.js";
import {
  deserializeCompressionInspectResult,
} from "../../../src/tools/compression-inspect.js";
import { projectProjectionToEnvelopes } from "../../../src/runtime/messages-transform.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "default plugin messages.transform preserves top-level tool host messages from runtime replay",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "shipped runtime tool replay",
    });

    const sessionMessages = [
      createMessageEnvelope({
        sessionID: fixture.sessionID,
        id: "msg-user-1",
        role: "user",
        created: 1,
        text: "User asks for the diagnostic recap.",
      }),
      createMessageEnvelope({
        sessionID: fixture.sessionID,
        id: "msg-assistant-1",
        role: "assistant",
        created: 2,
        text: "Assistant begins the recap.",
      }),
      createMessageEnvelope({
        sessionID: fixture.sessionID,
        id: "msg-tool-1",
        role: "tool",
        created: 3,
        text: "Tool emits the final diagnostic payload.",
      }),
    ];

    const hooks = await pluginModule.server(
      createPluginInput(fixture.repoRoot, {
        readSessionMessages: async () => ({ data: sessionMessages }),
      }),
    );

    const output = {
      messages: structuredClone(sessionMessages),
    };

    await hooks["experimental.chat.messages.transform"]?.({}, output);

    assert.equal(output.messages.length, 4);
    assert.match(
      output.messages[3]?.parts[0]?.type === "text"
        ? output.messages[3].parts[0].text
        : "",
      /^\[compressible_000003_[0-9A-Za-z]{2}\] Tool emits the final diagnostic payload\.$/u,
    );

    const evidencePath = await fixture.evidence.writeJson(
      "shipped-runtime-tool-replay",
      output.messages,
    );
    assert.match(evidencePath, /shipped-runtime-tool-replay\.json$/u);
  },
);

test(
  "projection materialization applies compression_mark tool result overrides to structured output",
  () => {
    const failureOutput = JSON.stringify({
      ok: false,
      errorCode: "INVALID_RANGE",
      message: "targets an unknown or reversed visible-id range",
      details: {
        sourceMessageId: "msg-assistant-override#compression_mark#call_mark",
        outcome: "rejected",
        mode: "compact",
        startVisibleMessageId: "compressible_999999_bad",
        endVisibleMessageId: "compressible_000001_bad",
      },
    });

    const envelopes = projectProjectionToEnvelopes({
      sessionId: "ses-runtime-override",
      messages: [
        {
          source: "canonical",
          role: "assistant",
          canonicalId: "msg-assistant-override",
          contentText: "Calling compression mark.",
          parts: [
            {
              type: "text",
              text: "Calling compression mark.",
              messageId: "msg-assistant-override",
            },
            {
              type: "tool",
              tool: "compression_mark",
              callID: "call_mark",
              state: {
                status: "completed",
                input: {
                  mode: "compact",
                  from: "compressible_000001_a1",
                  to: "compressible_000002_b2",
                },
                output: '{"ok":true,"markId":"mark_failed"}',
              },
              messageId: "msg-assistant-override",
            },
          ],
          hostMessage: {
            info: {
              id: "msg-assistant-override",
              sessionID: "ses-runtime-override",
              role: "assistant",
            },
            parts: [],
          },
        },
      ],
      toolResultOverrides: [
        {
          sourceMessageId: "msg-assistant-override#compression_mark#call_mark",
          toolName: "compression_mark",
          output: failureOutput,
        },
      ],
      reminders: [],
      conflicts: [],
      state: {
        sessionId: "ses-runtime-override",
        history: {
          sessionId: "ses-runtime-override",
          messages: [],
          marks: [],
          compressionMarkToolCalls: [],
        },
        markTree: { marks: [], conflicts: [] },
        conflicts: [],
        messagePolicies: [],
        visibleIdAllocations: [],
        resultGroups: [],
        failedToolMessageIds: new Map(),
      },
    });

    const toolPart = envelopes[0]?.parts.find(
      (part): part is Extract<Part, { type: "tool" }> => part.type === "tool",
    );
    assert.ok(toolPart);
    const toolOutput = readCompletedToolOutput(toolPart);
    assert.equal(toolOutput, failureOutput);

    const parsed = deserializeCompressionMarkResult(toolOutput);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.errorCode, "INVALID_RANGE");
    assert.equal(parsed.details?.outcome, "rejected");
  },
);

test(
  "projection materialization applies compression_inspect tool result overrides to structured output",
  () => {
    const inspectOutput = JSON.stringify({
      ok: true,
      messages: [
        {
          id: "compressible_000001_a1",
          tokens: 123,
        },
      ],
    });

    const envelopes = projectProjectionToEnvelopes({
      sessionId: "ses-runtime-inspect-override",
      messages: [
        {
          source: "canonical",
          role: "assistant",
          canonicalId: "msg-assistant-inspect",
          contentText: "Calling compression inspect.",
          parts: [
            {
              type: "text",
              text: "Calling compression inspect.",
              messageId: "msg-assistant-inspect",
            },
            {
              type: "tool",
              tool: "compression_inspect",
              callID: "call_inspect",
              state: {
                status: "completed",
                input: {
                  from: "compressible_000001_a1",
                  to: "compressible_000001_a1",
                },
                output: '{"ok":true,"inspectId":"inspect_placeholder"}',
              },
              messageId: "msg-assistant-inspect",
            },
            {
              type: "tool",
              tool: "read",
              callID: "call_read",
              state: {
                status: "completed",
                input: {},
                output: "ordinary tool output must stay untouched",
              },
              messageId: "msg-assistant-inspect",
            },
          ],
          hostMessage: {
            info: {
              id: "msg-assistant-inspect",
              sessionID: "ses-runtime-inspect-override",
              role: "assistant",
            },
            parts: [],
          },
        },
      ],
      toolResultOverrides: [
        {
          sourceMessageId: "msg-assistant-inspect#compression_inspect#call_inspect",
          toolName: "compression_inspect",
          output: inspectOutput,
        },
      ],
      reminders: [],
      conflicts: [],
      state: {
        sessionId: "ses-runtime-inspect-override",
        history: {
          sessionId: "ses-runtime-inspect-override",
          messages: [],
          marks: [],
          compressionMarkToolCalls: [],
        },
        markTree: { marks: [], conflicts: [] },
        conflicts: [],
        messagePolicies: [],
        visibleIdAllocations: [],
        resultGroups: [],
        failedToolMessageIds: new Map(),
      },
    });

    const toolParts = envelopes[0]?.parts.filter(
      (part): part is Extract<Part, { type: "tool" }> => part.type === "tool",
    );
    assert.equal(toolParts?.length, 2);
    assert.equal(readCompletedToolOutput(toolParts[0]!), inspectOutput);
    assert.equal(
      readCompletedToolOutput(toolParts[1]!),
      "ordinary tool output must stay untouched",
    );
    assert.deepEqual(deserializeCompressionInspectResult(inspectOutput), {
      ok: true,
      messages: [{ id: "compressible_000001_a1", tokens: 123 }],
    });
  },
);

test(
  "default plugin compression_mark admission follows runtime config allowDelete",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "shipped runtime delete admission",
    });
    const configDirectory = await mkdtemp(join(tmpdir(), "task12-runtime-config-"));
    t.after(async () => {
      await rm(configDirectory, { recursive: true, force: true });
    });

    const blockedHooks = await withRuntimeConfigPath(
      await writeRuntimeConfig(configDirectory, "blocked.json", false),
      () =>
        pluginModule.server(
          createPluginInput(fixture.repoRoot, {
            readSessionMessages: async () => ({ data: [] }),
          }),
        ),
    );
    const blockedSerialized = await blockedHooks.tool?.compression_mark?.execute(
      {
        mode: "delete",
        from: "compressible_000001_a1",
        to: "compressible_000002_b2",
      },
      createToolContext(fixture.sessionID),
    );
    assert.ok(typeof blockedSerialized === "string");
    assert.deepEqual(deserializeCompressionMarkResult(blockedSerialized), {
      ok: false,
      errorCode: "DELETE_NOT_ALLOWED",
      message:
        'compression_mark mode="delete" is not allowed in this session. Use mode="compact" instead to compress messages into summaries while preserving important information.',
    });

    const allowedHooks = await withRuntimeConfigPath(
      await writeRuntimeConfig(configDirectory, "allowed.json", true),
      () =>
        pluginModule.server(
          createPluginInput(fixture.repoRoot, {
            readSessionMessages: async () => ({ data: [] }),
          }),
        ),
    );
    const allowedSerialized = await allowedHooks.tool?.compression_mark?.execute(
      {
        mode: "delete",
        from: "compressible_000001_a1",
        to: "compressible_000002_b2",
      },
      createToolContext(fixture.sessionID),
    );
    assert.ok(typeof allowedSerialized === "string");

    const allowedResult = deserializeCompressionMarkResult(allowedSerialized);
    assert.equal(allowedResult.ok, true);
    if (allowedResult.ok) {
      assert.match(allowedResult.markId, /^mark_[0-9a-f]{12}$/u);
    }

    const evidencePath = await fixture.evidence.writeJson(
      "shipped-runtime-delete-admission",
      {
        blocked: deserializeCompressionMarkResult(blockedSerialized),
        allowed: allowedResult,
      },
    );
  assert.match(evidencePath, /shipped-runtime-delete-admission\.json$/u);
  },
);

test(
  "default plugin emits runtime events and overwrite-style debug snapshots when configured",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "runtime",
      caseName: "shipped runtime debug artifacts",
    });
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "task12-runtime-artifacts-"));
    t.after(async () => {
      await rm(runtimeDirectory, { recursive: true, force: true });
    });

    const runtimeLogPath = join(runtimeDirectory, "runtime-events.jsonl");
    const seamLogPath = join(runtimeDirectory, "seam-observation.jsonl");
    const debugSnapshotPath = join(runtimeDirectory, "debug-snapshots");

    const sessionMessages = [
      createMessageEnvelope({
        sessionID: fixture.sessionID,
        id: "msg-user-1",
        role: "user",
        created: 1,
        text: "User asks for the diagnostic recap.",
      }),
      createMessageEnvelope({
        sessionID: fixture.sessionID,
        id: "msg-assistant-1",
        role: "assistant",
        created: 2,
        text: "Assistant begins the recap.",
      }),
    ];

    const hooks = await withRuntimeEnv(
      {
        [RUNTIME_CONFIG_ENV.configPath]: await writeRuntimeConfig(
          runtimeDirectory,
          "debug-artifacts.json",
          false,
          {
            runtimeLogPath,
            seamLogPath,
          },
        ),
        [RUNTIME_CONFIG_ENV.debugSnapshotPath]: debugSnapshotPath,
      },
      () =>
        pluginModule.server(
          createPluginInput(fixture.repoRoot, {
            readSessionMessages: async () => ({ data: sessionMessages }),
          }),
        ),
    );

    const output = {
      messages: structuredClone(sessionMessages),
    };
    await hooks["experimental.chat.messages.transform"]?.({}, output);

    const runtimeEvents = (await readFile(runtimeLogPath, "utf8"))
     .trim()
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            seam: string;
            stage: string;
            sessionID: string;
            payload?: {
              messageCount?: number;
              projectionDebug?: {
                canonicalMessageCount: number;
                projectedMessageCount: number;
                compressionMarkToolCalls: {
                  total: number;
                  accepted: number;
                };
                replayedMarkIntents: {
                  total: number;
                };
                resultGroups: {
                  count: number;
                };
                reminders: {
                  count: number;
                };
              };
            };
          },
      );
    assert.deepEqual(
      runtimeEvents.map((event) => ({
        seam: event.seam,
        stage: event.stage,
        sessionID: event.sessionID,
      })),
      [
        {
          seam: undefined,
          stage: undefined,
          sessionID: "plugin-startup",
        },
        {
          seam: undefined,
          stage: undefined,
          sessionID: "plugin-startup",
        },
        {
          seam: "experimental.chat.messages.transform",
          stage: "gate",
          sessionID: fixture.sessionID,
        },
        {
          seam: "experimental.chat.messages.transform",
          stage: "completed",
          sessionID: fixture.sessionID,
        },
      ],
    );
    assert.equal(runtimeEvents[3]?.payload?.projectionDebug?.canonicalMessageCount, 2);
    assert.equal(runtimeEvents[3]?.payload?.projectionDebug?.projectedMessageCount, 3);
    assert.equal(
      runtimeEvents[3]?.payload?.projectionDebug?.compressionMarkToolCalls.total,
      0,
    );
    assert.equal(
      runtimeEvents[3]?.payload?.projectionDebug?.compressionMarkToolCalls.accepted,
      0,
    );
    assert.equal(
      runtimeEvents[3]?.payload?.projectionDebug?.replayedMarkIntents.total,
      0,
    );
    assert.equal(runtimeEvents[3]?.payload?.projectionDebug?.resultGroups.count, 0);
    assert.equal(runtimeEvents[3]?.payload?.projectionDebug?.reminders.count, 0);

    const inputSnapshot = JSON.parse(
      await readFile(join(debugSnapshotPath, `${fixture.sessionID}.hook-in.json`), "utf8"),
    ) as {
      messages: Array<{ parts: Array<{ text?: string }> }>;
    };
    const outputSnapshot = JSON.parse(
      await readFile(join(debugSnapshotPath, `${fixture.sessionID}.out.json`), "utf8"),
    ) as {
      messages: Array<{ parts: Array<{ text?: string }> }>;
    };
    const projectedTexts = outputSnapshot.messages.map(
      (message) => message.parts[0]?.text ?? "",
    );
    const projectedUserMessage = projectedTexts.find((text) =>
      text.includes("User asks for the diagnostic recap."),
    );
    const projectedAssistantMessage = projectedTexts.find((text) =>
      text.includes("Assistant begins the recap."),
    );

    assert.equal(
      inputSnapshot.messages[0]?.parts[0]?.text,
      "User asks for the diagnostic recap.",
    );
    assert.ok(projectedUserMessage);
    assert.match(
      projectedUserMessage,
      /^\[protected_000001_[0-9A-Za-z]{2}\] User asks for the diagnostic recap\.$/u,
    );
    assert.ok(projectedAssistantMessage);
    assert.match(
      projectedAssistantMessage,
      /^\[compressible_000002_[0-9A-Za-z]{2}\] Assistant begins the recap\.$/u,
    );
  },
);

function createPluginInput(
  repoRoot: string,
  options: {
    readonly readSessionMessages: (
      ...args: unknown[]
    ) => Promise<{ data: Array<{ info: Message; parts: Part[] }> }>;
  },
): PluginInput {
  return {
    client: {
      session: {
        messages: options.readSessionMessages,
      },
    } as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: repoRoot,
    worktree: repoRoot,
    serverUrl: new URL("http://localhost:3900"),
    $: {} as PluginInput["$"],
  };
}

function readCompletedToolOutput(part: Extract<Part, { type: "tool" }>): string {
  const state = part.state;
  assert.equal(state.status, "completed");
  assert.equal(typeof state.output, "string");
  return state.output;
}

function createMessageEnvelope(input: {
  readonly sessionID: string;
  readonly id: string;
  readonly role: "user" | "assistant" | "tool";
  readonly created: number;
  readonly text: string;
}): { info: Message; parts: Part[] } {
  return {
    info: {
      id: input.id,
      sessionID: input.sessionID,
      role: input.role,
      time: { created: input.created },
      agent: "atlas",
      model: {
        providerID: "openai.right",
        modelID: "gpt-5.4-mini",
      },
    } as Message,
    parts: [
      {
        id: `${input.id}:text`,
        sessionID: input.sessionID,
        messageID: input.id,
        type: "text" as const,
        text: input.text,
      },
    ] as Part[],
  };
}

function createToolContext(sessionID: string) {
  return {
    sessionID,
    messageID: "msg-runtime-delete-admission",
    agent: "atlas",
    directory: "/tmp/plugin-runtime-regression",
    worktree: "/tmp/plugin-runtime-regression",
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  };
}

async function writeRuntimeConfig(
  directory: string,
  fileName: string,
  allowDelete: boolean,
  paths: {
    readonly runtimeLogPath?: string;
    readonly seamLogPath?: string;
  } = {},
): Promise<string> {
  const configPath = join(directory, fileName);
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        allowDelete,
        promptPath: "prompts/compaction.md",
        compactionModels: ["openai.right/gpt-5.4-mini"],
        runtimeLogPath: paths.runtimeLogPath ?? "logs/runtime-events.jsonl",
        seamLogPath: paths.seamLogPath ?? "logs/seam-observation.jsonl",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return configPath;
}

async function withRuntimeEnv<T>(
  overrides: Partial<Record<(typeof RUNTIME_CONFIG_ENV)[keyof typeof RUNTIME_CONFIG_ENV], string>>,
  run: () => Promise<T>,
): Promise<T> {
  const previousEntries = Object.entries(overrides).map(([key, value]) => [
    key,
    process.env[key],
    value,
  ] as const);

  for (const [key, , value] of previousEntries) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, previous] of previousEntries) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  }
}

async function withRuntimeConfigPath<T>(
  configPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[RUNTIME_CONFIG_ENV.configPath];
  process.env[RUNTIME_CONFIG_ENV.configPath] = configPath;

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[RUNTIME_CONFIG_ENV.configPath];
    } else {
      process.env[RUNTIME_CONFIG_ENV.configPath] = previous;
    }
  }
}
