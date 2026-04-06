import assert from "node:assert/strict";
import test from "node:test";

import { createCompactionInputBuilder } from "../../../src/compaction/input-builder.js";
import { createHermeticE2EFixture } from "../harness/fixture.js";

test(
  "compaction input builder freezes transcript data and preserves opaque placeholders",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "compaction",
      caseName: "input builder contract",
    });

    const builder = createCompactionInputBuilder();
    const transcript = [
      {
        role: "assistant" as const,
        hostMessageId: "host-assistant-1",
        canonicalMessageId: "canon-assistant-1",
        sourceStartSeq: 10,
        sourceEndSeq: 10,
        contentText: "Lead context that is still compressible.",
      },
      {
        role: "assistant" as const,
        hostMessageId: "host-result-1",
        canonicalMessageId: "result-block-1",
        sourceStartSeq: 11,
        sourceEndSeq: 12,
        opaquePlaceholder: {
          slot: "S1",
        },
        contentText: "Existing compact result that must stay opaque.",
      },
      {
        role: "tool" as const,
        hostMessageId: "host-tool-1",
        canonicalMessageId: "canon-tool-1",
        sourceStartSeq: 13,
        sourceEndSeq: 13,
        contentText: "Tail tool result that stays compressible.",
      },
    ];

    const request = await builder.build({
      sessionId: fixture.sessionID,
      markId: "mark-input-001",
      model: "openai.right/gpt-5.4-mini",
      executionMode: "compact",
      allowDelete: false,
      promptText: "Compress the frozen transcript.",
      timeoutMs: 12_000,
      transcript,
    });

    transcript[0]!.contentText = "mutated lead content";
    transcript[1]!.contentText = "mutated opaque content";
    transcript[1]!.opaquePlaceholder!.slot = "BROKEN";

    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.transcript), true);
    assert.equal(Object.isFrozen(request.transcript[1]), true);
    assert.equal(request.transcript[0]?.contentText, "Lead context that is still compressible.");
    assert.equal(
      request.transcript[1]?.contentText,
      '<opaque slot="S1">Existing compact result that must stay opaque.</opaque>',
    );
    assert.equal(request.transcript[1]?.opaquePlaceholderSlot, "S1");
    assert.equal(request.transcript[1]?.sourceStartSeq, 11);
    assert.equal(request.transcript[1]?.sourceEndSeq, 12);
    assert.equal(request.transcript[2]?.sequenceNumber, 3);

    const evidencePath = await fixture.evidence.writeJson(
      "input-builder-contract",
      request,
    );
    assert.match(evidencePath, /input-builder-contract\.json$/u);
  },
);

test(
  "compaction input builder preserves delete mode without compact-only placeholder rewrites",
  { concurrency: false },
  async (t) => {
    const fixture = await createHermeticE2EFixture(t, {
      suite: "compaction",
      caseName: "input builder delete mode",
    });

    const builder = createCompactionInputBuilder();
    const request = await builder.build({
      sessionId: fixture.sessionID,
      markId: "mark-delete-001",
      model: "openai.right/gpt-5.4-mini",
      executionMode: "delete",
      allowDelete: true,
      promptText: "Delete the marked range.",
      timeoutMs: 7_000,
      transcript: [
        {
          role: "user",
          hostMessageId: "host-user-1",
          canonicalMessageId: "canon-user-1",
          sourceStartSeq: 21,
          sourceEndSeq: 21,
          contentText: "Sensitive content slated for delete mode.",
        },
      ],
    });

    assert.equal(request.executionMode, "delete");
    assert.equal(request.allowDelete, true);
    assert.equal(
      request.transcript[0]?.contentText,
      "Sensitive content slated for delete mode.",
    );
  },
);
