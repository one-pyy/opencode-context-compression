#!/usr/bin/env node --import tsx
/**
 * Run projection on an existing .in (hook-in) debug snapshot and write the .out.
 *
 * Uses the same projection pipeline as the runtime, reading result groups
 * and visible-id allocations from the session's sidecar database.
 *
 * Usage:
 *   node --import tsx scripts/run-projection.ts <hook-in-file> [--gate-open]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { createDefaultMessagesTransformProjector } from "../src/runtime/default-messages-transform.js";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { resolvePluginStateDirectory, resolveSessionDatabasePath } from "../src/runtime/sidecar-layout.js";
import { openSessionSidecarRepository } from "../src/state/sidecar-store.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.error("Usage: node --import tsx scripts/run-projection.ts <hook-in-file> [--gate-open]");
    process.exit(args.length === 0 ? 1 : 0);
  }

  const hookInPath = resolve(args[0]);
  const gateOpen = args.includes("--gate-open");

  const raw = readFileSync(hookInPath, "utf-8");
  const parsed = JSON.parse(raw) as { messages: readonly unknown[] };

  // Preprocess: ensure every message has a non-null info.id
  const messages = parsed.messages.map((msg, index) => {
    const m = msg as { info: { id?: string | null; sessionID?: string; role?: string }; parts: unknown[] };
    if (!m.info.id) {
      m.info.id = `msg_${index + 1}`;
    }
    return m;
  });

  // Extract session ID from first message
  const firstMsg = messages[0] as { info?: { sessionID?: string } } | undefined;
  const sessionId = firstMsg?.info?.sessionID;
  if (!sessionId) {
    console.error("Could not extract sessionID from hook-in file.");
    process.exit(1);
  }

  console.error(`Session: ${sessionId}`);
  console.error(`Messages: ${messages.length}`);
  console.error(`Gate: ${gateOpen ? "open" : "closed"}`);

  // Load runtime config
  const pluginDirectory = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const runtimeConfig = await loadRuntimeConfig({ directory: pluginDirectory });

  // Create projector
  const projector = createDefaultMessagesTransformProjector({
    pluginDirectory,
    runtimeConfig,
    readSessionMessages: async () => messages as never,
  });

  // Run projection
  const envelopes = messages as never[];
  const projected = await projector.project({
    input: { sessionID: sessionId } as never,
    currentMessages: envelopes,
    replacementGateOpen: gateOpen,
  });

  // Write output
  const outPath = hookInPath.replace(/\.hook-in\.json$/, ".out.json");
  const outData = { messages: projected };
  writeFileSync(outPath, JSON.stringify(outData, null, 2));
  console.error(`Output written to: ${outPath}`);

  // Print summary
  const projectionState = projector.getLastProjectionState?.();
  const debugState = projector.getLastProjectionDebugState?.();
  if (debugState) {
    console.error(`\n--- Projection Summary ---`);
    console.error(`Projected messages: ${debugState.projectedMessageCount}`);
    console.error(`Compressible: ${debugState.visibleKindCounts.compressible}`);
    console.error(`Referable: ${debugState.visibleKindCounts.referable}`);
    console.error(`Protected: ${debugState.visibleKindCounts.protected}`);
    console.error(`Result groups: ${debugState.resultGroups.count}`);
    console.error(`Total compressible tokens: ${debugState.totalCompressibleTokenCount}`);
    console.error(`Uncompressed marked tokens: ${debugState.uncompressedMarkedTokenCount}`);
  }
}

await main();
