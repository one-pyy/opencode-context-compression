import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildCompactionResultGroup } from "../../src/compaction/runner/result-group.js";
import { createOutputValidator } from "../../src/compaction/output-validation.js";

test("ResultGroup Builder - Multiple Fragments on Incompressible Gap (15.18 & 15.33)", () => {
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
    contentText: "Summary part 1\n<opaque slot=\"S1\"/>\nSummary part 2"
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

test("ResultGroup Builder - Drops Short Text In Opaque-Only Window", () => {
  const transcript = [
    { sourceStartSeq: 1, sourceEndSeq: 1, contentText: "U1", role: "user" as const },
    { sourceStartSeq: 2, sourceEndSeq: 2, contentText: "<opaque slot=\"S1\">C1</opaque>", role: "assistant" as const, opaquePlaceholderSlot: "S1" },
    { sourceStartSeq: 3, sourceEndSeq: 3, contentText: "<opaque slot=\"S2\">C2</opaque>", role: "assistant" as const, opaquePlaceholderSlot: "S2" },
    { sourceStartSeq: 4, sourceEndSeq: 4, contentText: "U2", role: "user" as const }
  ];

  const request = {
    markID: "m1",
    model: "test-model",
    executionMode: "compact" as const,
    mode: "compact" as const,
    allowDelete: true,
    transcript
  };

  const validatedOutput = {
    contentText: "Summary 1\n<opaque slot=\"S1\"/>\n确认目标保持 active。\n<opaque slot=\"S2\"/>\nSummary 2"
  };

  const resultGroup = buildCompactionResultGroup({
    request: request as any,
    validatedOutput: validatedOutput as any,
    runInput: {} as any,
    now: () => new Date().toISOString()
  });

  assert.equal(resultGroup.fragments.length, 2);
  assert.equal(resultGroup.fragments[0].sourceStartSeq, 1);
  assert.equal(resultGroup.fragments[0].replacementText, "Summary 1");
  assert.equal(resultGroup.fragments[1].sourceStartSeq, 4);
  assert.equal(resultGroup.fragments[1].replacementText, "Summary 2");
});

test("ResultGroup Builder - Rejects Long Text In Opaque-Only Window", () => {
  const transcript = [
    { sourceStartSeq: 1, sourceEndSeq: 1, contentText: "U1", role: "user" as const },
    { sourceStartSeq: 2, sourceEndSeq: 2, contentText: "<opaque slot=\"S1\">C1</opaque>", role: "assistant" as const, opaquePlaceholderSlot: "S1" },
    { sourceStartSeq: 3, sourceEndSeq: 3, contentText: "<opaque slot=\"S2\">C2</opaque>", role: "assistant" as const, opaquePlaceholderSlot: "S2" },
    { sourceStartSeq: 4, sourceEndSeq: 4, contentText: "U2", role: "user" as const }
  ];

  const request = {
    markID: "m1",
    model: "test-model",
    executionMode: "compact" as const,
    mode: "compact" as const,
    allowDelete: true,
    transcript
  };

  const validatedOutput = {
    contentText: `Summary 1\n<opaque slot="S1"/>\n${"这是一段明显超过五十个汉字、本应属于其他窗口的正文内容，不应出现在相邻 opaque 标签之间，否则会破坏窗口映射并导致整条压缩结果无法提交。"}\n<opaque slot="S2"/>\nSummary 2`
  };

  assert.throws(
    () => buildCompactionResultGroup({
      request: request as any,
      validatedOutput: validatedOutput as any,
      runInput: {} as any,
      now: () => new Date().toISOString()
    }),
    /opaque-only window/
  );
});

test("ResultGroup Builder - Rejects Long English Text In Opaque-Only Window", () => {
  const transcript = [
    { sourceStartSeq: 1, sourceEndSeq: 1, contentText: "U1", role: "user" as const },
    { sourceStartSeq: 2, sourceEndSeq: 2, contentText: "<opaque slot=\"S1\">C1</opaque>", role: "assistant" as const, opaquePlaceholderSlot: "S1" },
    { sourceStartSeq: 3, sourceEndSeq: 3, contentText: "<opaque slot=\"S2\">C2</opaque>", role: "assistant" as const, opaquePlaceholderSlot: "S2" },
    { sourceStartSeq: 4, sourceEndSeq: 4, contentText: "U2", role: "user" as const }
  ];

  const request = {
    markID: "m1",
    model: "test-model",
    executionMode: "compact" as const,
    mode: "compact" as const,
    allowDelete: true,
    transcript
  };

  const longEnglishText =
    "This misplaced paragraph clearly belongs to a different window and should never appear between two adjacent opaque slots because it would corrupt the mapping of source ranges and fail the entire compaction result for this mark and also discard otherwise valid work.";

  const validatedOutput = {
    contentText: `Summary 1\n<opaque slot="S1"/>\n${longEnglishText}\n<opaque slot="S2"/>\nSummary 2`
  };

  assert.throws(
    () => buildCompactionResultGroup({
      request: request as any,
      validatedOutput: validatedOutput as any,
      runInput: {} as any,
      now: () => new Date().toISOString()
    }),
    /opaque-only window/
  );
});

test("Output Validator - Missing Placeholder Throws Error (15.34 & 15.35)", async () => {
  const validator = createOutputValidator();
  
  const request = {
    markID: "m1",
    model: "test-model",
    executionMode: "compact" as const, mode: "compact" as const, allowDelete: true, sessionID: "mock-session", promptText: "", timeoutMs: 1000, transcript: [
      { sequenceNumber: 1, role: "user" as const, hostMessageID: "h1", sourceStartSeq: 1, sourceEndSeq: 1, contentText: "U1" },
      { sequenceNumber: 2, role: "assistant" as const, hostMessageID: "h2", sourceStartSeq: 2, sourceEndSeq: 2, contentText: "<opaque slot=\"S1\">C1</opaque>", opaquePlaceholderSlot: "S1" },
      { sequenceNumber: 3, role: "user" as const, hostMessageID: "h3", sourceStartSeq: 3, sourceEndSeq: 3, contentText: "U2" }
    ]
  };

  // LLM hallucinated and dropped S1
  const badPayload = {
          contentText: JSON.stringify({
            plan: "Summarize the source windows.",
            compression_output: "I completely summarized it but forgot the opaque tag!",
          })
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
    executionMode: "delete" as const,
    mode: "delete" as const,
    allowDelete: true,
    sessionID: "mock-session",
    promptText: "",
    timeoutMs: 1000,
    transcript: [
      { sequenceNumber: 1, role: "user" as const, hostMessageID: "h1", sourceStartSeq: 1, sourceEndSeq: 1, contentText: "U1" },
      { sequenceNumber: 2, role: "assistant" as const, hostMessageID: "h2", sourceStartSeq: 2, sourceEndSeq: 2, contentText: "<opaque slot=\"S1\">C1</opaque>", opaquePlaceholderSlot: "S1" }
    ]
  };

  // Even if S1 is missing, it's fine because mode is delete
  const payload = {
          contentText: JSON.stringify({
            plan: "Prepare the delete notice.",
            compression_output: "[Deleted]",
          })
  };

  const validated = await validator.validate({ request, response: { rawPayload: payload } });
  assert.equal(validated.contentText, "[Deleted]");
});
