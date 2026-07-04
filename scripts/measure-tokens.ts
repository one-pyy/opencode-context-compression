#!/usr/bin/env node --import tsx
/**
 * Measure token count in a debug snapshot `.out` file.
 *
 * Uses the exact same rendering and estimation code as the runtime:
 *   - renderModelVisiblePartsText from src/model-visible-transcript.ts
 *   - estimateEnvelopeTokensWithService from src/token-estimation.ts
 *
 * Usage:
 *   node --import tsx scripts/measure-tokens.ts <input-file>
 *   npm run measure-tokens -- <input-file>
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderModelVisiblePartsText } from "../src/model-visible-transcript.js";
import { estimateEnvelopeTokensWithService } from "../src/token-estimation.js";
import type { TransformEnvelope } from "../src/seams/noop-observation.js";

const VISIBLE_ID_PATTERN =
  /^\[(protected|compressible|referable)_\d{6}_[0-9A-Za-z]+(?:~(?:protected|compressible|referable)_\d{6}_[0-9A-Za-z]+)?\]\s?/u;

type VisibleKind = "protected" | "compressible" | "referable" | "unmarked";

interface CategoryStats {
  messageCount: number;
  tokenCount: number;
  charCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function classifyMessage(text: string): VisibleKind {
  const match = text.match(VISIBLE_ID_PATTERN);
  if (!match) return "unmarked";
  return match[1] as VisibleKind;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.error(
      `Usage: node --import tsx scripts/measure-tokens.ts <input-file>`,
    );
    process.exit(args.length === 0 ? 1 : 0);
  }

  const inputPath = resolve(args[0]);
  let raw: string;
  try {
    raw = readFileSync(inputPath, "utf-8");
  } catch (err) {
    console.error(`Error reading file: ${inputPath}`);
    console.error(err);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`Error parsing JSON: ${inputPath}`);
    console.error(err);
    process.exit(1);
  }

  const messages = isRecord(parsed) && Array.isArray(parsed.messages)
    ? parsed.messages
    : [];

  const stats: Record<VisibleKind, CategoryStats> = {
    protected: { messageCount: 0, tokenCount: 0, charCount: 0 },
    compressible: { messageCount: 0, tokenCount: 0, charCount: 0 },
    referable: { messageCount: 0, tokenCount: 0, charCount: 0 },
    unmarked: { messageCount: 0, tokenCount: 0, charCount: 0 },
  };

  for (const msg of messages) {
    if (!isRecord(msg) || !Array.isArray(msg.parts)) continue;
    const text = renderModelVisiblePartsText(msg.parts);
    if (text.length === 0) continue;

    const kind = classifyMessage(text);
    const estimate = await estimateEnvelopeTokensWithService({
      envelope: msg as unknown as TransformEnvelope,
    });

    stats[kind].messageCount++;
    stats[kind].tokenCount += estimate.tokenCount;
    stats[kind].charCount += text.length;
  }

  const totalTokens =
    stats.protected.tokenCount +
    stats.compressible.tokenCount +
    stats.referable.tokenCount +
    stats.unmarked.tokenCount;
  const totalMessages =
    stats.protected.messageCount +
    stats.compressible.messageCount +
    stats.referable.messageCount +
    stats.unmarked.messageCount;

  const result = {
    file: inputPath,
    totalMessages,
    totalTokens,
    uncompressedTokens: stats.compressible.tokenCount,
    compressedTokens: stats.referable.tokenCount,
    protectedTokens: stats.protected.tokenCount,
    unmarkedTokens: stats.unmarked.tokenCount,
    breakdown: {
      protected: stats.protected,
      compressible: stats.compressible,
      referable: stats.referable,
      unmarked: stats.unmarked,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

await main();
