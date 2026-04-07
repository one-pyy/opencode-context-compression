import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PluginInput } from "@opencode-ai/plugin";
import type { Message, Part } from "@opencode-ai/sdk";

import pluginModule from "../../../src/index.js";
import {
  RUNTIME_CONFIG_ENV,
  resolveRuntimeConfigRepoRoot,
} from "../../../src/config/runtime-config.js";
import {
  deserializeCompressionMarkResult,
} from "../../../src/tools/compression-mark.js";
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

    assert.equal(output.messages.length, 3);
    assert.match(
      output.messages[2]?.parts[0]?.type === "text"
        ? output.messages[2].parts[0].text
        : "",
      /^\[compressible_000003_[0-9A-Za-z]{8}\] Tool emits the final diagnostic payload\.$/u,
    );

    const evidencePath = await fixture.evidence.writeJson(
      "shipped-runtime-tool-replay",
      output.messages,
    );
    assert.match(evidencePath, /shipped-runtime-tool-replay\.json$/u);
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
        contractVersion: "v1",
        mode: "delete",
        target: {
          startVisibleMessageID: "compressible_000001_a1",
          endVisibleMessageID: "compressible_000002_b2",
        },
      },
      createToolContext(fixture.sessionID),
    );
    assert.ok(typeof blockedSerialized === "string");
    assert.deepEqual(deserializeCompressionMarkResult(blockedSerialized), {
      ok: false,
      errorCode: "DELETE_NOT_ALLOWED",
      message:
        "compression_mark mode='delete' is blocked by the current delete-admission policy.",
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
        contractVersion: "v1",
        mode: "delete",
        target: {
          startVisibleMessageID: "compressible_000001_a1",
          endVisibleMessageID: "compressible_000002_b2",
        },
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
        runtimeLogPath: "logs/runtime-events.jsonl",
        seamLogPath: "logs/seam-observation.jsonl",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return configPath;
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
