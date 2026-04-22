import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPRESSION_MARK_EXTERNAL_CONTRACT,
  createCompressionMarkFailure,
  createCompressionMarkTool,
  deserializeCompressionMarkResult,
  executeCompressionMark,
  validateCompressionMarkInput,
  type CompressionMarkAdmissionInput,
  type CompressionMarkToolInvocationContext,
} from "../../../src/tools/compression-mark.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "compression_mark accepts one visible-id range and returns markId while rejecting legacy or batch inputs",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "interfaces",
      caseName: "compression mark contract",
    });

    const valid = validateCompressionMarkInput({
      mode: "compact",
      from: "compressible_000001_a1",
      to: "compressible_000004_b2",
    });
    assert.equal(valid.ok, true);

    const invalidLegacyShape = validateCompressionMarkInput({
      mode: "compact",
      range: {
        startVisibleMessageID: "compressible_000001_a1",
        endVisibleMessageID: "compressible_000004_b2",
      },
    });
    assert.equal(invalidLegacyShape.ok, false);
    if (!invalidLegacyShape.ok) {
      assert.equal(invalidLegacyShape.result.errorCode, "INVALID_RANGE");
        assert.match(
          invalidLegacyShape.result.message,
          /compression_mark from and to/u,
        );
      }

    const invalidBatchShape = validateCompressionMarkInput({
      mode: "compact",
      target: [
        {
          startVisibleMessageID: "compressible_000001_a1",
          endVisibleMessageID: "compressible_000004_b2",
        },
      ],
    });
    assert.equal(invalidBatchShape.ok, false);
    if (!invalidBatchShape.ok) {
      assert.equal(invalidBatchShape.result.errorCode, "INVALID_RANGE");
      assert.match(
        invalidBatchShape.result.message,
        /compression_mark from and to must both be non-empty strings/u,
      );
    }

    const result = await executeCompressionMark(
      {
        mode: "compact",
        from: "compressible_000001_a1",
        to: "compressible_000004_b2",
      },
      createInvocationContext(fixture.sessionID),
      {
        createMarkID(input) {
          return `mark-for-${input.from}`;
        },
      },
    );

    assert.deepEqual(result, {
      ok: true,
      markId: "mark-for-compressible_000001_a1",
    });
    assert.equal(
      COMPRESSION_MARK_EXTERNAL_CONTRACT.relationToRuntime.resultGroups,
      "markId is the lookup key for future committed result-groups",
    );

    const evidencePath = await fixture.evidence.writeJson(
      "compression-mark-contract-success",
      result,
    );
    assert.match(evidencePath, /compression-mark-contract-success\.json$/u);
  },
);

test("compression_mark returns DESIGN-aligned delete blocked and injected admission errors", async () => {
  const deleteBlocked = await executeCompressionMark(
    {
      mode: "delete",
      from: "compressible_000010_c1",
      to: "compressible_000012_c3",
    },
    createInvocationContext("session-delete-blocked"),
  );
  assert.deepEqual(deleteBlocked, {
    ok: false,
    errorCode: "DELETE_NOT_ALLOWED",
    message:
      'compression_mark mode="delete" is not allowed in this session. Use mode="compact" instead to compress messages into summaries while preserving important information.',
  });

  const overlapConflict = await executeCompressionMark(
    {
      mode: "compact",
      from: "compressible_000010_c1",
      to: "compressible_000012_c3",
    },
    createInvocationContext("session-overlap"),
    {
      admission(input: CompressionMarkAdmissionInput) {
        assert.equal(input.mode, "compact");
        return createCompressionMarkFailure(
          "OVERLAP_CONFLICT",
          "compression_mark overlaps an existing later mark without containment.",
        );
      },
    },
  );
  assert.deepEqual(overlapConflict, {
    ok: false,
    errorCode: "OVERLAP_CONFLICT",
    message:
      "compression_mark overlaps an existing later mark without containment.",
  });

  const notReady = await executeCompressionMark(
    {
      mode: "compact",
      from: "compressible_000010_c1",
      to: "compressible_000012_c3",
    },
    createInvocationContext(""),
  );
  assert.equal(notReady.ok, false);
  if (!notReady.ok) {
    assert.equal(notReady.errorCode, "SESSION_NOT_READY");
  }
});

test("compression_mark tool serializes the external contract result", async () => {
  const definition = createCompressionMarkTool({
    createMarkID() {
      return "mark-serialized-001";
    },
  });

  const payload = await definition.execute(
    {
      mode: "compact",
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

  assert.deepEqual(deserializeCompressionMarkResult(payload), {
    ok: true,
    markId: "mark-serialized-001",
  });
});

function createInvocationContext(
  sessionID: string,
): CompressionMarkToolInvocationContext {
  return {
    sessionID,
    messageID: "msg-contract",
    agent: "atlas",
    directory: "/tmp/plugin-contract",
    worktree: "/tmp/plugin-contract",
    abort: new AbortController().signal,
  };
}
