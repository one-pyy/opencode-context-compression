import assert from "node:assert/strict";
import test from "node:test";

import {
  createNoopObservationHooks,
  type ChatParamsInput,
  type ChatParamsOutput,
  type MessagesTransformOutput,
  type ShapeSummary,
  type ToolExecuteBeforeInput,
  type ToolExecuteBeforeOutput,
  type TransformEnvelope,
  type TransformMessage,
  type TransformPart,
} from "../../src/seams/noop-observation.js";

test("experimental.chat.messages.transform stays no-op while recording identity-bearing fields", async () => {
  const { hooks, journal } = createNoopObservationHooks();
  const transform = hooks["experimental.chat.messages.transform"];
  const messages = createTransformMessages();
  const output = deepFreeze({ messages } satisfies MessagesTransformOutput);

  await transform({}, output);

  assert.equal(output.messages, messages);
  assert.equal(output.messages[0], messages[0]);
  assert.equal(output.messages[0]?.info, messages[0]?.info);
  assert.deepEqual(output.messages, messages);
  assert.equal(journal.entries.length, 1);

  const observation = journal.entries[0];
  assert.ok(observation);
  assert.equal(observation?.seam, "experimental.chat.messages.transform");
  assert.deepEqual(
    observation?.identityFields,
    [
      { path: "output.messages[0].info.id", value: "user-1" },
      { path: "output.messages[0].info.sessionID", value: "session-1" },
      { path: "output.messages[0].parts[0].id", value: "part-user-1" },
      { path: "output.messages[0].parts[0].sessionID", value: "session-1" },
      { path: "output.messages[0].parts[0].messageID", value: "user-1" },
      { path: "output.messages[1].info.id", value: "assistant-1" },
      { path: "output.messages[1].info.sessionID", value: "session-1" },
      { path: "output.messages[1].info.parentID", value: "user-1" },
      { path: "output.messages[1].parts[0].id", value: "part-assistant-1" },
      { path: "output.messages[1].parts[0].sessionID", value: "session-1" },
      { path: "output.messages[1].parts[0].messageID", value: "assistant-1" },
    ],
  );

  const outputShape = expectObjectShape(observation.outputShape);
  assert.deepEqual(outputShape.keys, ["messages"]);

  const messagesShape = expectArrayShape(outputShape.entries?.messages);
  assert.deepEqual(messagesShape, {
    kind: "array",
    length: 2,
    elementKinds: ["object"],
    sample: {
      kind: "object",
      keys: ["info", "parts"],
      entries: {
        info: {
          kind: "object",
          keys: ["agent", "id", "model", "role", "sessionID", "time"],
        },
        parts: {
          kind: "array",
          length: 1,
          elementKinds: ["object"],
          sample: undefined,
        },
      },
    },
  });
});

test("chat.params and tool.execute.before observations preserve call order and identities", async () => {
  const { hooks, journal } = createNoopObservationHooks();
  const chatParams = hooks["chat.params"];
  const toolExecuteBefore = hooks["tool.execute.before"];
  const model = createChatModel();
  const provider = createProviderContext(model);

  const chatParamsInput = {
    sessionID: "session-1",
    agent: "main",
    model,
    provider,
    message: {
      id: "user-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 1 },
      agent: "main",
      model: {
        providerID: "provider-1",
        modelID: "gpt-5",
      },
    },
  } satisfies ChatParamsInput;

  const chatParamsOutput = {
    temperature: 0,
    topP: 1,
    topK: 40,
    options: {
      trace: true,
    },
  } satisfies ChatParamsOutput;

  const toolInput = {
    tool: "bash",
    sessionID: "session-1",
    callID: "tool-call-1",
  } satisfies ToolExecuteBeforeInput;

  const toolOutput = {
    args: {
      command: "pwd",
    },
  } satisfies ToolExecuteBeforeOutput;

  await chatParams(chatParamsInput, chatParamsOutput);
  await toolExecuteBefore(toolInput, toolOutput);

  assert.deepEqual(
    journal.entries.map((entry) => ({ seam: entry.seam, sequence: entry.sequence })),
    [
      { seam: "chat.params", sequence: 1 },
      { seam: "tool.execute.before", sequence: 2 },
    ],
  );

  assert.deepEqual(journal.entries[0]?.identityFields, [
    { path: "input.sessionID", value: "session-1" },
    { path: "input.message.id", value: "user-1" },
    { path: "input.message.sessionID", value: "session-1" },
  ]);

  assert.deepEqual(journal.entries[1]?.identityFields, [
    { path: "input.sessionID", value: "session-1" },
    { path: "input.callID", value: "tool-call-1" },
  ]);
});

function createTransformMessages(): MessagesTransformOutput["messages"] {
  const userMessage: TransformMessage = {
    id: "user-1",
    sessionID: "session-1",
    role: "user",
    time: { created: 1 },
    agent: "main",
    model: {
      providerID: "provider-1",
      modelID: "gpt-5",
    },
  };

  const assistantMessage: TransformMessage = {
    id: "assistant-1",
    sessionID: "session-1",
    role: "assistant",
    time: { created: 2, completed: 3 },
    parentID: "user-1",
    modelID: "gpt-5",
    providerID: "provider-1",
    mode: "chat",
    path: {
      cwd: "/tmp/session-1",
      root: "/tmp",
    },
    cost: 0,
    tokens: {
      input: 10,
      output: 20,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  };

  const userPart: TransformPart = {
    id: "part-user-1",
    sessionID: "session-1",
    messageID: "user-1",
    type: "text",
    text: "hello",
  };

  const assistantPart: TransformPart = {
    id: "part-assistant-1",
    sessionID: "session-1",
    messageID: "assistant-1",
    type: "text",
    text: "world",
  };

  return [
    {
      info: userMessage,
      parts: [userPart],
    },
    {
      info: assistantMessage,
      parts: [assistantPart],
    },
  ] satisfies TransformEnvelope[];
}

function createChatModel(): ChatParamsInput["model"] {
  return {
    id: "gpt-5",
    providerID: "provider-1",
    api: {
      id: "responses",
      url: "https://example.invalid/v1/responses",
      npm: "@example/provider",
    },
    name: "GPT 5",
    capabilities: {
      temperature: true,
      reasoning: true,
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
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: {
      context: 128000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  };
}

function createProviderContext(model: ChatParamsInput["model"]): ChatParamsInput["provider"] {
  return {
    source: "custom",
    info: {
      id: "provider-1",
      name: "Provider 1",
      source: "custom",
      env: [],
      options: {
        region: "local",
      },
      models: {
        [model.id]: model,
      },
    },
    options: {
      region: "local",
    },
  };
}

function expectObjectShape(shape: ShapeSummary | undefined): Extract<ShapeSummary, { kind: "object" }> {
  assert.ok(shape);
  assert.equal(shape.kind, "object");

  return shape as Extract<ShapeSummary, { kind: "object" }>;
}

function expectArrayShape(shape: ShapeSummary | undefined): Extract<ShapeSummary, { kind: "array" }> {
  assert.ok(shape);
  assert.equal(shape.kind, "array");

  return shape as Extract<ShapeSummary, { kind: "array" }>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    Object.freeze(value);

    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nestedValue);
    }
  }

  return value;
}
