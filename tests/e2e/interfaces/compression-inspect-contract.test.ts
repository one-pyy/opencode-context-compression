import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPRESSION_INSPECT_EXTERNAL_CONTRACT,
  createCompressionInspectTool,
  deserializeCompressionInspectResult,
  executeCompressionInspect,
  validateCompressionInspectInput,
  type CompressionInspectToolInvocationContext,
} from "../../../src/tools/compression-inspect.js";

test("compression_inspect validates one visible-id range and returns a placeholder", async () => {
  const valid = validateCompressionInspectInput({
    from: "compressible_000001_a1",
    to: "compressible_000004_b2",
  });
  assert.equal(valid.ok, true);

  const invalid = validateCompressionInspectInput({
    target: {
      from: "compressible_000001_a1",
      to: "compressible_000004_b2",
    },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.result.errorCode, "INVALID_RANGE");
    assert.match(invalid.result.message, /compression_inspect from and to/u);
  }

  const result = await executeCompressionInspect(
    {
      from: "compressible_000001_a1",
      to: "compressible_000004_b2",
    },
    createInvocationContext("session-inspect"),
    {
      createInspectID(input) {
        return `inspect-for-${input.from}`;
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    inspectId: "inspect-for-compressible_000001_a1",
  });
  assert.equal(
    COMPRESSION_INSPECT_EXTERNAL_CONTRACT.relationToRuntime.tokenCounts,
    "uses ProjectionState.messagePolicies from messages.transform and never recalculates tokens in the tool",
  );
});

test("compression_inspect tool serializes the placeholder result", async () => {
  const definition = createCompressionInspectTool({
    createInspectID() {
      return "inspect-serialized-001";
    },
  });

  const payload = await definition.execute(
    {
      from: "compressible_000001_a1",
      to: "compressible_000004_b2",
    },
    {
      sessionID: "session-tool-contract",
      messageID: "msg-tool-contract",
      agent: "atlas",
      directory: "/tmp/plugin-contract",
      worktree: "/tmp/plugin-contract",
      abort: new AbortController().signal,
      metadata() {},
      ask: async () => {},
    },
  );

  assert.deepEqual(deserializeCompressionInspectResult(payload), {
    ok: true,
    inspectId: "inspect-serialized-001",
  });
});

function createInvocationContext(
  sessionID: string,
): CompressionInspectToolInvocationContext {
  return {
    sessionID,
    messageID: "msg-contract",
    agent: "atlas",
    directory: "/tmp/plugin-contract",
    worktree: "/tmp/plugin-contract",
    abort: new AbortController().signal,
  };
}
