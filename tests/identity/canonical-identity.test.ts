import assert from "node:assert/strict";
import test from "node:test";

import {
  pickEarliestSourceCanonicalIdentity,
  resolveHostMessageCanonicalIdentity,
} from "../../src/identity/canonical-identity.js";
import type { TransformEnvelope, TransformMessage, TransformPart } from "../../src/seams/noop-observation.js";

test("canonical host identity uses message.info.id and treats parts[*].messageID as corroboration", () => {
  const identity = resolveHostMessageCanonicalIdentity(
    createEnvelope({
      info: createMessage({
        id: "msg-assistant-1",
        sessionID: "session-1",
        role: "assistant",
        parentID: "msg-user-1",
        time: { created: 42 },
      }),
      parts: [
        createPart({ id: "part-1", sessionID: "session-1", messageID: "msg-assistant-1" }),
        createPart({ id: "part-2", sessionID: "session-1", messageID: "msg-assistant-1" }),
      ],
    }),
  );

  assert.deepEqual(identity, {
    hostMessageID: "msg-assistant-1",
    canonicalMessageID: "msg-assistant-1",
    role: "assistant",
    sessionID: "session-1",
    parentID: "msg-user-1",
    hostCreatedAtMs: 42,
    corroboratingPartMessageIDs: ["msg-assistant-1"],
  });
});

test("canonical host identity rejects part messageID mismatches instead of using them as the source of truth", () => {
  assert.throws(
    () =>
      resolveHostMessageCanonicalIdentity(
        createEnvelope({
          info: createMessage({ id: "msg-user-1", sessionID: "session-1", role: "user" }),
          parts: [createPart({ id: "part-1", sessionID: "session-1", messageID: "msg-other" })],
        }),
      ),
    /Canonical identity mismatch/,
  );
});

test("referable blocks inherit the earliest source canonical identity", () => {
  assert.deepEqual(
    pickEarliestSourceCanonicalIdentity([
      {
        hostMessageID: "msg-earliest",
        canonicalMessageID: "msg-earliest",
      },
      {
        hostMessageID: "msg-later",
        canonicalMessageID: "msg-later",
      },
    ]),
    {
      hostMessageID: "msg-earliest",
      canonicalMessageID: "msg-earliest",
    },
  );
});

function createEnvelope(input: {
  readonly info: TransformMessage;
  readonly parts: TransformPart[];
}): TransformEnvelope {
  return {
    info: input.info,
    parts: input.parts,
  };
}

function createMessage(input: {
  readonly id: string;
  readonly sessionID: string;
  readonly role: string;
  readonly parentID?: string;
  readonly time?: { readonly created: number };
}): TransformMessage {
  return {
    id: input.id,
    sessionID: input.sessionID,
    role: input.role,
    agent: "main",
    model: {
      providerID: "provider-1",
      modelID: "gpt-5",
    },
    time: input.time ?? { created: 1 },
    ...(input.parentID ? { parentID: input.parentID } : {}),
  } as TransformMessage;
}

function createPart(input: {
  readonly id: string;
  readonly sessionID: string;
  readonly messageID?: string;
}): TransformPart {
  return {
    id: input.id,
    sessionID: input.sessionID,
    ...(input.messageID ? { messageID: input.messageID } : {}),
    type: "text",
    text: "content",
  } as TransformPart;
}
