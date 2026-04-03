import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";

import { loadRuntimeConfig } from "./config/runtime-config.js";
import { createMessagesTransformHook } from "./projection/messages-transform.js";
import { createSendEntryGateHooks } from "./runtime/send-entry-gate.js";
import { createFileBackedSeamObservationJournal } from "./seams/file-journal.js";
import { createNoopObservationHooks, createSeamObservationJournal } from "./seams/noop-observation.js";

const plugin: Plugin = async (ctx) => {
  const runtimeConfig = loadRuntimeConfig();
  const journal = createFileBackedSeamObservationJournal(
    createSeamObservationJournal(),
    runtimeConfig.seamLogPath,
  );
  const { hooks: observedHooks } = createNoopObservationHooks(journal);
  const hooks: Hooks = { ...observedHooks };
  const sendEntryHooks = createSendEntryGateHooks({
    pluginDirectory: ctx.directory,
  });

  const observedMessagesTransform = hooks["experimental.chat.messages.transform"];
  const observedToolExecuteBefore = hooks["tool.execute.before"];
  const messagesTransform = createMessagesTransformHook({
    pluginDirectory: ctx.directory,
  });
  hooks["experimental.chat.messages.transform"] = async (input, output) => {
    await messagesTransform(input, output);
    await observedMessagesTransform?.(input, output);
  };
  hooks["chat.message"] = sendEntryHooks["chat.message"];
  hooks["tool.execute.before"] = async (input, output) => {
    await observedToolExecuteBefore?.(input, output);
    await sendEntryHooks["tool.execute.before"]?.(input, output);
  };

  recordPluginInitObservation(ctx, journal);

  return hooks;
};

export default plugin;

function recordPluginInitObservation(
  ctx: PluginInput,
  journal: ReturnType<typeof createSeamObservationJournal>,
): void {
  const sessionObject = readSessionObject(ctx.client);
  const clientSessionKeys = Object.keys(sessionObject).sort();
  const clientSessionMethods = readSessionPrototypeMethods(sessionObject);
  const clientRootKeys = readOwnKeys(ctx.client);
  const internalClientKeys = readInternalClientKeys(ctx.client);

  journal.record({
    seam: "tool.execute.before",
    inputShape: {
      kind: "object",
      keys: ["pluginInit"],
      entries: {
        pluginInit: {
          kind: "object",
          keys: [
            "clientPresent",
            "clientRootKeys",
            "clientSessionKeys",
            "clientSessionMethods",
            "internalClientKeys",
            "directory",
            "worktree",
          ],
          entries: {
            clientPresent: { kind: typeof ctx.client === "object" ? "boolean" : "undefined" },
            clientRootKeys: {
              kind: "array",
              length: clientRootKeys.length,
              elementKinds: ["string"],
            },
            clientSessionKeys: {
              kind: "array",
              length: clientSessionKeys.length,
              elementKinds: ["string"],
            },
            clientSessionMethods: {
              kind: "array",
              length: clientSessionMethods.length,
              elementKinds: ["string"],
            },
            internalClientKeys: {
              kind: "array",
              length: internalClientKeys.length,
              elementKinds: ["string"],
            },
            directory: { kind: "string" },
            worktree: { kind: "string" },
          },
        },
      },
    },
    outputShape: {
      kind: "object",
      keys: ["clientRootKeys", "clientSessionKeys", "clientSessionMethods", "internalClientKeys"],
      entries: {
        clientRootKeys: {
          kind: "array",
          length: clientRootKeys.length,
          elementKinds: ["string"],
        },
        clientSessionKeys: {
          kind: "array",
          length: clientSessionKeys.length,
          elementKinds: ["string"],
        },
        clientSessionMethods: {
          kind: "array",
          length: clientSessionMethods.length,
          elementKinds: ["string"],
        },
        internalClientKeys: {
          kind: "array",
          length: internalClientKeys.length,
          elementKinds: ["string"],
        },
      },
    },
    identityFields: [
      { path: "pluginInit.directory", value: ctx.directory },
      { path: "pluginInit.worktree", value: ctx.worktree },
      ...clientRootKeys.map((name) => ({
        path: "pluginInit.client.key",
        value: name,
      })),
      ...clientSessionKeys.map((name) => ({
        path: "pluginInit.client.session.key",
        value: name,
      })),
      ...clientSessionMethods.map((name) => ({
        path: "pluginInit.client.session.method",
        value: name,
      })),
      ...internalClientKeys.map((name) => ({
        path: "pluginInit.client._client.key",
        value: name,
      })),
    ],
  });
}

function readOwnKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.keys(value as Record<string, unknown>).sort();
}

function readSessionObject(client: PluginInput["client"]): Record<string, unknown> {
  const maybeClient = client as unknown;
  if (!maybeClient || typeof maybeClient !== "object") {
    return {};
  }

  const session = (maybeClient as { session?: unknown }).session;
  if (!session || typeof session !== "object") {
    return {};
  }

  return session as Record<string, unknown>;
}

function readInternalClientKeys(client: PluginInput["client"]): string[] {
  const maybeClient = client as unknown;
  if (!maybeClient || typeof maybeClient !== "object") {
    return [];
  }

  const internal = (maybeClient as { _client?: unknown })._client;
  if (!internal || typeof internal !== "object") {
    return [];
  }

  return Object.keys(internal as Record<string, unknown>).sort();
}

function readSessionPrototypeMethods(sessionObject: Record<string, unknown>): string[] {
  const proto = Object.getPrototypeOf(sessionObject);
  if (!proto || typeof proto !== "object") {
    return [];
  }

  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor")
    .filter((name) => typeof (sessionObject as Record<string, unknown>)[name] === "function")
    .sort();
}
