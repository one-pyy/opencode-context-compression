import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildCompactionResultGroup } from "../../src/compaction/runner/result-group.js";
import { includesOpaquePlaceholder } from "../../src/compaction/opaque-placeholders.js";
import { createOutputValidator } from "../../src/compaction/output-validation.js";

test("ResultGroup Builder - Multiple Fragments on Incompressible Gap (15.18 & 15.33)", () => {
  // Simulating an LLM output that correctly kept the placeholder S1
  const payload = {
    content_text: "Summary part 1\n<opaque slot=\"S1\">C1</opaque>\nSummary part 2"
  };

  const transcript = [
    { sourceStartSeq: 1, sourceEndSeq: 1, contentText: "U1", role: "user" as const },
    { sourceStartSeq: 2, sourceEndSeq: 2, contentText: "<opaque slot=\"S1\">C1</opaque>", role: "assistant" as const, opaquePlaceholderSlot: "S1" },
    { sourceStartSeq: 3, sourceEndSeq: 3, contentText: "U2", role: "user" as const }
  ];

  const request = {
    markID: "m1",
    model: "test-model",
    executionMode: "auto",
    mode: "compact" as const,
    allowDelete: true,
    transcript
  };

  const validatedOutput = {
    contentText: "Summary part 1\n<opaque slot=\"S1\">C1</opaque>\nSummary part 2"
  };

  const runInput = {
    mark: { sourceSequence: 3 }
  } as any;

  const resultGroup = buildCompactionResultGroup({
    request: request as any,
    validatedOutput: validatedOutput as any,
    runInput,
    now: () => new Date().toISOString()
  });

  // Since it spans U1(1) to U2(3) and skips C1(2) due to the placeholder S1
  console.log("FRAGMENTS:", resultGroup.fragments);
  assert.equal(resultGroup.fragments.length, 2);

  // First fragment before S1: covers U1 (Seq 1)
  assert.equal(resultGroup.fragments[0].sourceStartSeq, 1);
  assert.equal(resultGroup.fragments[0].sourceEndSeq, 1);
  assert.equal(resultGroup.fragments[0].replacementText.trim(), "Summary part 1");

  // Second fragment after S1: covers U2 (Seq 3)
  assert.equal(resultGroup.fragments[1].sourceStartSeq, 3);
  assert.equal(resultGroup.fragments[1].sourceEndSeq, 3);
  assert.equal(resultGroup.fragments[1].replacementText.trim(), "Summary part 2");
});

test("Output Validator - Missing Placeholder Throws Error (15.34 & 15.35)", async () => {
  const validator = createOutputValidator();
  
  const request = {
    markID: "m1",
    model: "test-model",
    executionMode: "auto", mode: "compact" as const, allowDelete: true, sessionID: "mock-session", promptText: "", timeoutMs: 1000, transcript: [
      { role: "user" as const, contentText: "U1", sequence: 1 },
      { role: "assistant" as const, contentText: "<opaque slot=\"S1\">C1</opaque>", sequence: 2, opaquePlaceholderSlot: "S1" },
      { role: "user" as const, contentText: "U2", sequence: 3 }
    ]
  };

  // LLM hallucinated and dropped S1
  const badPayload = {
    contentText: "I completely summarized it but forgot the XML tag!"
  };

  let errorOccurred = false;
  try {
    await validator.validate({ request, response: { rawPayload: badPayload } });
  } catch (err: any) {
    errorOccurred = true;
    // DESIGN.md 15.18 says it should be considered an error, but does not mandate the specific Error class name.
    assert.ok(err instanceof Error, "Implementation violates 15.18: Must throw an Error when placeholder is missing.");
  }

  assert.equal(errorOccurred, true);
});

test("Output Validator - Delete Mode Skips Placeholder Check (15.19)", async () => {
  const validator = createOutputValidator();
  
  const request = {
    markID: "m1",
    model: "test-model",
    executionMode: "delete" as const, // <--- Here is the fix
    mode: "delete" as const, // delete mode!
    allowDelete: true,
    transcript: [
      { role: "user" as const, contentText: "U1", sequence: 1 },
      { role: "assistant" as const, contentText: "C1", sequence: 2, opaquePlaceholderSlot: "S1" }
    ]
  };

  // Even if S1 is missing, it's fine because mode is delete
  const payload = {
    contentText: "[Deleted]"
  };

  const validated = await validator.validate({ request, response: { rawPayload: payload } });
  assert.equal(validated.contentText, "[Deleted]");
});
