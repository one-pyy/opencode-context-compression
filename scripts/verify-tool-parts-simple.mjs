#!/usr/bin/env node
/**
 * Simple verification: Tool parts preservation through the plugin pipeline
 */

import { projectProjectionToEnvelopes } from "../dist/runtime/messages-transform.js";

console.log("🔍 Tool Parts Preservation Verification\n");
console.log("=".repeat(60));

const testProjection = {
  sessionId: "test-session",
  messages: [
    {
      source: "canonical",
      role: "user",
      canonicalId: "msg-1",
      visibleKind: "compressible",
      visibleId: "compressible_000001_u1",
      contentText: "Search for auth patterns.",
      parts: [
        { type: "text", text: "Search for auth patterns.", messageId: "msg-1" }
      ]
    },
    {
      source: "canonical",
      role: "assistant",
      canonicalId: "msg-2",
      visibleKind: "compressible",
      visibleId: "compressible_000002_a1",
      contentText: "I'll search for that.",
      parts: [
        { type: "text", text: "I'll search for that.", messageId: "msg-2" },
        {
          type: "tool",
          tool: "grep",
          callID: "call-1",
          state: {
            status: "completed",
            input: { pattern: "auth" },
            output: "Found 15 matches"
          },
          messageId: "msg-2"
        }
      ]
    },
    {
      source: "canonical",
      role: "user",
      canonicalId: "msg-3",
      visibleKind: "compressible",
      visibleId: "compressible_000003_u2",
      contentText: "Check the schema.",
      parts: [
        { type: "text", text: "Check the schema.", messageId: "msg-3" }
      ]
    },
    {
      source: "canonical",
      role: "assistant",
      canonicalId: "msg-4",
      visibleKind: "compressible",
      visibleId: "compressible_000004_a2",
      contentText: "Let me read it.",
      parts: [
        { type: "text", text: "Let me read it.", messageId: "msg-4" },
        {
          type: "tool",
          tool: "read",
          callID: "call-2",
          state: {
            status: "completed",
            input: { filePath: "schema.sql" },
            output: "CREATE TABLE users..."
          },
          messageId: "msg-4"
        }
      ]
    }
  ],
  reminders: [],
  conflicts: [],
  state: {}
};

console.log("\n📝 Input projection:");
const inputToolParts = testProjection.messages.flatMap(m => m.parts || []).filter(p => p.type === "tool");
console.log(`   - ${testProjection.messages.length} messages`);
console.log(`   - ${inputToolParts.length} tool parts:`);
inputToolParts.forEach(tp => {
  console.log(`     • ${tp.tool} (${tp.callID}) - ${tp.state.status}`);
});

console.log("\n🔄 Converting projection to envelopes...");
const envelopes = projectProjectionToEnvelopes(testProjection);

console.log("\n📦 Output envelopes:");
console.log(`   - ${envelopes.length} envelopes`);

const outputToolParts = envelopes.flatMap(e => e.parts).filter(p => p.type === "tool");
console.log(`   - ${outputToolParts.length} tool parts:`);
outputToolParts.forEach(tp => {
  console.log(`     • ${tp.tool} (${tp.callID}) - ${tp.state?.status || 'unknown'}`);
});

console.log("\n🔬 Verification:");
if (outputToolParts.length !== inputToolParts.length) {
  console.error(`   ❌ FAIL: Tool parts count mismatch!`);
  console.error(`      Expected: ${inputToolParts.length}, Got: ${outputToolParts.length}`);
  process.exit(1);
}

for (let i = 0; i < inputToolParts.length; i++) {
  const input = inputToolParts[i];
  const output = outputToolParts[i];

  if (input.tool !== output.tool) {
    console.error(`   ❌ FAIL: Tool name mismatch at index ${i}`);
    console.error(`      Expected: ${input.tool}, Got: ${output.tool}`);
    process.exit(1);
  }

  if (input.callID !== output.callID) {
    console.error(`   ❌ FAIL: Call ID mismatch at index ${i}`);
    console.error(`      Expected: ${input.callID}, Got: ${output.callID}`);
    process.exit(1);
  }

  if (input.state?.status !== output.state?.status) {
    console.error(`   ❌ FAIL: State status mismatch at index ${i}`);
    console.error(`      Expected: ${input.state?.status}, Got: ${output.state?.status}`);
    process.exit(1);
  }

  console.log(`   ✓ Tool part ${i + 1}: ${input.tool} (${input.callID}) - preserved correctly`);
}

console.log("\n" + "=".repeat(60));
console.log("✅ SUCCESS: All tool parts preserved through the pipeline!");
console.log("=".repeat(60));
