#!/usr/bin/env node

import { createProjectionBuilder } from "../src/projection/projection-builder.js";
import { projectProjectionToEnvelopes } from "../src/runtime/messages-transform.js";
import { createHistoryReplayReaderFromSources } from "../src/history/history-replay-reader.js";
import type { ReplayHistorySources } from "../src/history/history-replay-reader.js";
import { createPolicyEngine } from "../src/projection/policy-engine.js";
import { createMarkTreeBuilder } from "../src/projection/mark-tree.js";

interface TestMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  parts: Array<{
    type: string;
    text?: string;
    tool?: string;
    callID?: string;
    state?: any;
    [key: string]: any;
  }>;
}

function createTestConversation(): TestMessage[] {
  return [
    {
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "Search for authentication patterns in the codebase." }]
    },
    {
      id: "msg-2",
      role: "assistant",
      parts: [
        { type: "text", text: "I'll search for authentication patterns." },
        {
          type: "tool",
          tool: "grep",
          callID: "call-1",
          state: {
            status: "completed",
            input: { pattern: "auth", path: "src/" },
            output: "Found 15 matches in 8 files:\nsrc/auth/login.ts:10\nsrc/auth/middleware.ts:25\n..."
          }
        }
      ]
    },
    {
      id: "msg-3",
      role: "user",
      parts: [{ type: "text", text: "Now check the database schema." }]
    },
    {
      id: "msg-4",
      role: "assistant",
      parts: [
        { type: "text", text: "Let me read the schema file." },
        {
          type: "tool",
          tool: "read",
          callID: "call-2",
          state: {
            status: "completed",
            input: { filePath: "schema.sql" },
            output: "CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  email VARCHAR(255) UNIQUE NOT NULL,\n  password_hash VARCHAR(255) NOT NULL\n);"
          }
        }
      ]
    },
    {
      id: "msg-5",
      role: "user",
      parts: [{ type: "text", text: "Great, thanks!" }]
    }
  ];
}

function convertToReplayHistorySources(messages: TestMessage[]): ReplayHistorySources {
  return {
    sessionId: "test-session-tool-preservation",
    hostHistory: messages.map((msg, idx) => ({
      sequence: idx + 1,
      message: {
        info: {
          id: msg.id,
          role: msg.role
        },
        parts: msg.parts.map(part => ({
          type: part.type,
          text: part.text,
          tool: part.tool,
          callID: part.callID,
          state: part.state,
          messageId: msg.id,
          ...part
        }))
      }
    })),
    toolHistory: [],
    compressionMarkToolCalls: []
  };
}

async function runVerification() {
  console.log("🔍 Tool Parts Preservation Verification\n");
  console.log("=" .repeat(60));

  const testMessages = createTestConversation();
  console.log(`\n📝 Created test conversation with ${testMessages.length} messages`);

  // Count input tool parts
  const inputToolParts = testMessages.flatMap(m => m.parts).filter(p => p.type === "tool");
  console.log(`   - Input contains ${inputToolParts.length} tool parts`);
  inputToolParts.forEach(tp => {
    console.log(`     • ${tp.tool} (${tp.callID})`);
  });

  // Convert to replay sources
  const sources = convertToReplayHistorySources(testMessages);
  const replayReader = createHistoryReplayReaderFromSources(sources);
  const history = await replayReader.read("test-session-tool-preservation");

  console.log(`\n📚 History replay completed`);
  console.log(`   - Replayed ${history.messages.length} messages`);

  // Verify parts in replayed history
  const replayedToolParts = history.messages.flatMap(m => m.parts).filter(p => p.type === "tool");
  console.log(`   - Replayed history contains ${replayedToolParts.length} tool parts`);

  if (replayedToolParts.length !== inputToolParts.length) {
    console.error(`\n❌ FAIL: Tool parts lost during history replay!`);
    console.error(`   Expected: ${inputToolParts.length}, Got: ${replayedToolParts.length}`);
    process.exit(1);
  }

  // Build projection (no compression marks, just pass-through)
  const policyEngine = createPolicyEngine();
  const markTreeBuilder = createMarkTreeBuilder();
  const projectionBuilder = createProjectionBuilder({
    policyEngine,
    markTreeBuilder
  });

  const policies = policyEngine.buildPolicies({
    history,
    config: {
      smallUserMessageThreshold: 50,
      reminder: {
        hsoft: 30000,
        hhard: 88000,
        softRepeatEveryTokens: 20000,
        hardRepeatEveryTokens: 10000,
        allowDelete: false
      }
    }
  });

  const markTree = markTreeBuilder.build({
    marks: [],
    policies
  });

  const projection = await projectionBuilder.build({
    sessionId: "test-session-tool-preservation",
    history,
    markTree,
    visibleIdAllocations: [],
    resultGroups: [],
    config: {
      smallUserMessageThreshold: 50,
      reminder: {
        hsoft: 30000,
        hhard: 88000,
        softRepeatEveryTokens: 20000,
        hardRepeatEveryTokens: 10000,
        allowDelete: false
      }
    }
  });

  console.log(`\n🎯 Projection built`);
  console.log(`   - Projected ${projection.messages.length} messages`);

  // Verify parts in projection
  const projectedToolParts = projection.messages.flatMap(m => m.parts || []).filter(p => p.type === "tool");
  console.log(`   - Projection contains ${projectedToolParts.length} tool parts`);

  if (projectedToolParts.length !== inputToolParts.length) {
    console.error(`\n❌ FAIL: Tool parts lost during projection!`);
    console.error(`   Expected: ${inputToolParts.length}, Got: ${projectedToolParts.length}`);
    process.exit(1);
  }

  // Convert to envelopes (final output format)
  const envelopes = projectProjectionToEnvelopes(projection);

  console.log(`\n📦 Envelopes generated`);
  console.log(`   - Generated ${envelopes.length} envelopes`);

  // Verify parts in final envelopes
  const outputToolParts = envelopes.flatMap(e => e.parts).filter(p => p.type === "tool");
  console.log(`   - Final output contains ${outputToolParts.length} tool parts`);

  if (outputToolParts.length !== inputToolParts.length) {
    console.error(`\n❌ FAIL: Tool parts lost during envelope conversion!`);
    console.error(`   Expected: ${inputToolParts.length}, Got: ${outputToolParts.length}`);
    process.exit(1);
  }

  // Detailed verification
  console.log(`\n🔬 Detailed verification:`);
  for (let i = 0; i < inputToolParts.length; i++) {
    const input = inputToolParts[i];
    const output = outputToolParts[i];

    console.log(`\n   Tool part ${i + 1}:`);
    console.log(`     Input:  ${input.tool} (${input.callID})`);
    console.log(`     Output: ${output.tool} (${output.callID})`);

    if (input.tool !== output.tool) {
      console.error(`     ❌ Tool name mismatch!`);
      process.exit(1);
    }

    if (input.callID !== output.callID) {
      console.error(`     ❌ Call ID mismatch!`);
      process.exit(1);
    }

    if (input.state && output.state) {
      if (input.state.status !== output.state.status) {
        console.error(`     ❌ State status mismatch!`);
        process.exit(1);
      }
      console.log(`     ✓ State preserved (${input.state.status})`);
    }

    console.log(`     ✓ Tool part preserved correctly`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ SUCCESS: All tool parts preserved through the entire pipeline!`);
  console.log(`\n   Input:      ${inputToolParts.length} tool parts`);
  console.log(`   Replayed:   ${replayedToolParts.length} tool parts`);
  console.log(`   Projected:  ${projectedToolParts.length} tool parts`);
  console.log(`   Output:     ${outputToolParts.length} tool parts`);
  console.log(`\n🎉 The fix is working correctly!\n`);
}

runVerification().catch(err => {
  console.error("\n💥 Verification failed with error:");
  console.error(err);
  process.exit(1);
});
