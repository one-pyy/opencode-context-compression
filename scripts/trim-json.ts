#!/usr/bin/env node --import tsx
/**
 * JSON Trimming Tool for Debug Snapshot Analysis
 * 
 * Truncates long string fields in JSON files while preserving structure.
 * Essential for analyzing large debug snapshot files efficiently.
 * 
 * Usage:
 *   npm run trim-json <input-file> [max-length]
 *   node --import tsx scripts/trim-json.ts <input-file> [max-length]
 * 
 * Examples:
 *   npm run trim-json logs/debug-snapshots/ses_xxx.in.json
 *   npm run trim-json logs/debug-snapshots/ses_xxx.out.json 200
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_MAX_LENGTH = 150;
const TRUNCATION_SUFFIX = '... [truncated]';

interface TrimStats {
  totalStrings: number;
  truncatedStrings: number;
  totalCharsRemoved: number;
}

function trimValue(value: unknown, maxLength: number, stats: TrimStats): unknown {
  if (typeof value === 'string') {
    stats.totalStrings++;
    if (value.length > maxLength) {
      stats.truncatedStrings++;
      stats.totalCharsRemoved += value.length - maxLength;
      return value.slice(0, maxLength) + TRUNCATION_SUFFIX;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => trimValue(item, maxLength, stats));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = trimValue(val, maxLength, stats);
    }
    return result;
  }

  return value;
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
JSON Trimming Tool for Debug Snapshot Analysis

Usage:
  npm run trim-json <input-file> [max-length]
  node --import tsx scripts/trim-json.ts <input-file> [max-length]

Arguments:
  input-file   Path to JSON file (relative or absolute)
  max-length   Maximum string length before truncation (default: ${DEFAULT_MAX_LENGTH})

Examples:
  npm run trim-json logs/debug-snapshots/ses_xxx.in.json
  npm run trim-json logs/debug-snapshots/ses_xxx.out.json 200

Output:
  Trimmed JSON is written to stdout
  Statistics are written to stderr
`);
    process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
  }

  const inputPath = resolve(args[0]);
  const maxLength = args[1] ? parseInt(args[1], 10) : DEFAULT_MAX_LENGTH;

  if (isNaN(maxLength) || maxLength < 1) {
    console.error(`Error: max-length must be a positive integer, got: ${args[1]}`);
    process.exit(1);
  }

  let rawContent: string;
  try {
    rawContent = readFileSync(inputPath, 'utf-8');
  } catch (err) {
    console.error(`Error reading file: ${inputPath}`);
    console.error(err);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    console.error(`Error parsing JSON from: ${inputPath}`);
    console.error(err);
    process.exit(1);
  }

  const stats: TrimStats = {
    totalStrings: 0,
    truncatedStrings: 0,
    totalCharsRemoved: 0,
  };

  const trimmed = trimValue(parsed, maxLength, stats);

  // Output trimmed JSON to stdout
  console.log(JSON.stringify(trimmed, null, 2));

  // Output stats to stderr
  console.error(`\n--- Trimming Statistics ---`);
  console.error(`File: ${inputPath}`);
  console.error(`Max length: ${maxLength}`);
  console.error(`Total strings: ${stats.totalStrings}`);
  console.error(`Truncated strings: ${stats.truncatedStrings}`);
  console.error(`Total chars removed: ${stats.totalCharsRemoved.toLocaleString()}`);
  console.error(`Truncation rate: ${((stats.truncatedStrings / stats.totalStrings) * 100).toFixed(1)}%`);
}

main();
