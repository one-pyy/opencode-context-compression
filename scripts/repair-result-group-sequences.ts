#!/usr/bin/env node --import tsx
/**
 * Repair legacy result group source sequences for an existing session.
 *
 * The old replay model let plugin tool-result events occupy message sequence
 * slots. After removing those synthetic sequence slots, old result group ranges
 * can point at the wrong messages. This script rebuilds fragment ranges from
 * preserved compaction request transcripts and rewrites the SQLite sidecar.
 *
 * Dry-run by default. Use --apply to write changes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import YAML from "yaml";

import { createSqliteDatabase } from "../src/state/sqlite-runtime.js";

interface HookMessage {
  readonly info?: {
    readonly id?: string | null;
    readonly role?: string;
  };
}

interface TranscriptEntry {
  readonly hostMessageID: string;
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly opaquePlaceholderSlot?: string;
}

interface CompactionRequestRecord {
  readonly markID: string;
  readonly transcript: readonly TranscriptEntry[];
}

interface ResultGroupRow extends Record<string, unknown> {
  readonly mark_id: string;
  readonly source_start_seq: number;
  readonly source_end_seq: number;
  readonly fragment_count: number;
}

interface ResultFragmentRow extends Record<string, unknown> {
  readonly mark_id: string;
  readonly fragment_index: number;
  readonly source_start_seq: number;
  readonly source_end_seq: number;
}

interface FragmentRepair {
  readonly fragmentIndex: number;
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly sourceStartCanonicalId: string;
  readonly sourceEndCanonicalId: string;
}

interface GroupRepair {
  readonly markId: string;
  readonly recordPath: string;
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly fragments: readonly FragmentRepair[];
}

interface Args {
  readonly sessionId: string;
  readonly hookInPath: string;
  readonly databasePath: string;
  readonly recordsDir: string;
  readonly apply: boolean;
}

const root = resolve(new URL("..", import.meta.url).pathname);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sequenceByCanonicalId = buildCurrentSequenceMap(args.hookInPath);
  const requestsByMarkId = loadCompactionRequests(args.recordsDir, args.sessionId);
  const database = createSqliteDatabase(args.databasePath, {
    enableForeignKeyConstraints: true,
  });

  try {
    const groups = database
      .prepare<ResultGroupRow>(
        `SELECT mark_id, source_start_seq, source_end_seq, fragment_count FROM result_groups ORDER BY mark_id ASC`,
      )
      .all();
    const repairs: GroupRepair[] = [];
    const skipped: string[] = [];

    for (const group of groups) {
      const request = requestsByMarkId.get(group.mark_id);
      if (request === undefined) {
        skipped.push(`${group.mark_id}: missing compaction request record`);
        continue;
      }

      const repair = buildGroupRepair({
        group,
        request: request.record,
        recordPath: request.path,
        sequenceByCanonicalId,
      });
      if (repair === undefined) {
        skipped.push(`${group.mark_id}: could not map transcript windows to current messages`);
        continue;
      }
      repairs.push(repair);
    }

    printPlan({ repairs, skipped, apply: args.apply });

    if (args.apply) {
      applyRepairs(database, repairs);
      console.log(`Applied ${repairs.length} result group repairs.`);
    }
  } finally {
    database.close();
  }
}

function parseArgs(argv: readonly string[]): Args {
  const sessionId = readFlag(argv, "--session") ?? readFlag(argv, "-s");
  if (sessionId === undefined) {
    throw new Error("Usage: node --import tsx scripts/repair-result-group-sequences.ts --session <session-id> [--apply]");
  }

  return {
    sessionId,
    hookInPath:
      readFlag(argv, "--hook-in") ??
      join(root, "logs", "debug-snapshots", `${sessionId}.hook-in.json`),
    databasePath:
      readFlag(argv, "--db") ?? join(root, "state", `${sessionId}.db`),
    recordsDir:
      readFlag(argv, "--records-dir") ?? join(root, "logs", "compaction-records"),
    apply: argv.includes("--apply"),
  };
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return argv[index + 1];
}

function buildCurrentSequenceMap(hookInPath: string): ReadonlyMap<string, number> {
  const parsed = JSON.parse(readFileSync(hookInPath, "utf-8")) as {
    readonly messages: readonly HookMessage[];
  };
  const sequenceByCanonicalId = new Map<string, number>();
  let sequence = 1;

  for (const message of parsed.messages) {
    if (!isHostRole(message.info?.role)) {
      continue;
    }
    const id = message.info?.id;
    if (id !== undefined && id !== null && id.trim().length > 0) {
      sequenceByCanonicalId.set(id, sequence);
    }
    sequence += 1;
  }

  return sequenceByCanonicalId;
}

function isHostRole(role: string | undefined): boolean {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function loadCompactionRequests(
  recordsDir: string,
  sessionId: string,
): ReadonlyMap<string, { readonly path: string; readonly record: CompactionRequestRecord }> {
  const result = new Map<string, { readonly path: string; readonly record: CompactionRequestRecord }>();
  const files = readdirSync(recordsDir)
    .filter((file) => file.includes(sessionId) && file.endsWith(".in.yaml"))
    .sort();

  for (const file of files) {
    const path = join(recordsDir, file);
    const parsed = YAML.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isCompactionRequestRecord(parsed)) {
      continue;
    }
    // Later records for the same mark overwrite earlier failed/retried attempts.
    result.set(parsed.markID, { path, record: parsed });
  }

  return result;
}

function isCompactionRequestRecord(value: unknown): value is CompactionRequestRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { markID?: unknown }).markID === "string" &&
    Array.isArray((value as { transcript?: unknown }).transcript)
  );
}

function buildGroupRepair(input: {
  readonly group: ResultGroupRow;
  readonly request: CompactionRequestRecord;
  readonly recordPath: string;
  readonly sequenceByCanonicalId: ReadonlyMap<string, number>;
}): GroupRepair | undefined {
  const transcriptWindows = computeFragmentWindows(input.request.transcript);
  if (transcriptWindows.length !== input.group.fragment_count) {
    return undefined;
  }

  const mappedTranscript = mapTranscriptRange(
    input.request.transcript,
    input.sequenceByCanonicalId,
  );
  if (mappedTranscript === undefined) {
    return undefined;
  }

  const fragments: FragmentRepair[] = [];
  for (let index = 0; index < transcriptWindows.length; index += 1) {
    const window = transcriptWindows[index];
    const mappedWindow = mapTranscriptRange(window, input.sequenceByCanonicalId);
    if (mappedWindow === undefined) {
      return undefined;
    }
    fragments.push({
      fragmentIndex: index,
      sourceStartSeq: mappedWindow.startSequence,
      sourceEndSeq: mappedWindow.endSequence,
      sourceStartCanonicalId: mappedWindow.startCanonicalId,
      sourceEndCanonicalId: mappedWindow.endCanonicalId,
    });
  }

  return {
    markId: input.group.mark_id,
    recordPath: input.recordPath,
    sourceStartSeq: mappedTranscript.startSequence,
    sourceEndSeq: mappedTranscript.endSequence,
    fragments,
  };
}

function computeFragmentWindows(
  transcript: readonly TranscriptEntry[],
): readonly (readonly TranscriptEntry[])[] {
  const placeholders = transcript
    .map((entry, index) => ({ entry, index }))
    .filter((item) => item.entry.opaquePlaceholderSlot !== undefined);
  if (placeholders.length === 0) {
    return [transcript.filter((entry) => entry.opaquePlaceholderSlot === undefined)];
  }

  const windows: readonly TranscriptEntry[][] = [];
  const result: TranscriptEntry[][] = [];
  let cursor = 0;
  for (const placeholder of placeholders) {
    const window = transcript
      .slice(cursor, placeholder.index)
      .filter((entry) => entry.opaquePlaceholderSlot === undefined);
    if (window.length > 0) {
      result.push(window);
    }
    cursor = placeholder.index + 1;
  }

  const tail = transcript
    .slice(cursor)
    .filter((entry) => entry.opaquePlaceholderSlot === undefined);
  if (tail.length > 0) {
    result.push(tail);
  }

  return windows.concat(result);
}

function mapTranscriptRange(
  transcript: readonly TranscriptEntry[],
  sequenceByCanonicalId: ReadonlyMap<string, number>,
):
  | {
      readonly startSequence: number;
      readonly endSequence: number;
      readonly startCanonicalId: string;
      readonly endCanonicalId: string;
    }
  | undefined {
  const mapped = transcript
    .map((entry) => mapEntryToCurrentSequence(entry, sequenceByCanonicalId))
    .filter((entry): entry is { readonly canonicalId: string; readonly sequence: number } =>
      entry !== undefined,
    );

  if (mapped.length === 0) {
    return undefined;
  }

  const last = mapped[mapped.length - 1];
  return {
    startSequence: mapped[0].sequence,
    endSequence: last.sequence,
    startCanonicalId: mapped[0].canonicalId,
    endCanonicalId: last.canonicalId,
  };
}

function mapEntryToCurrentSequence(
  entry: TranscriptEntry,
  sequenceByCanonicalId: ReadonlyMap<string, number>,
): { readonly canonicalId: string; readonly sequence: number } | undefined {
  const direct = sequenceByCanonicalId.get(entry.hostMessageID);
  if (direct !== undefined) {
    return { canonicalId: entry.hostMessageID, sequence: direct };
  }

  const hostId = stripReplayToolSuffix(entry.hostMessageID);
  if (hostId !== entry.hostMessageID) {
    const hostSequence = sequenceByCanonicalId.get(hostId);
    if (hostSequence !== undefined) {
      return { canonicalId: hostId, sequence: hostSequence };
    }
  }

  return undefined;
}

function stripReplayToolSuffix(canonicalId: string): string {
  const suffixIndex = canonicalId.indexOf("#compression_");
  return suffixIndex < 0 ? canonicalId : canonicalId.slice(0, suffixIndex);
}

function printPlan(input: {
  readonly repairs: readonly GroupRepair[];
  readonly skipped: readonly string[];
  readonly apply: boolean;
}): void {
  console.log(
    JSON.stringify(
      {
        mode: input.apply ? "apply" : "dry-run",
        repairCount: input.repairs.length,
        skippedCount: input.skipped.length,
        skipped: input.skipped,
        sample: input.repairs.slice(0, 5).map((repair) => ({
          markId: repair.markId,
          sourceStartSeq: repair.sourceStartSeq,
          sourceEndSeq: repair.sourceEndSeq,
          fragmentCount: repair.fragments.length,
          record: basename(repair.recordPath),
        })),
      },
      null,
      2,
    ),
  );
}

function applyRepairs(
  database: ReturnType<typeof createSqliteDatabase>,
  repairs: readonly GroupRepair[],
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const updateGroup = database.prepare(
      `UPDATE result_groups
       SET source_start_seq = :source_start_seq,
           source_end_seq = :source_end_seq
       WHERE mark_id = :mark_id`,
    );
    const updateFragment = database.prepare(
      `UPDATE result_fragments
       SET source_start_seq = :source_start_seq,
           source_end_seq = :source_end_seq
       WHERE mark_id = :mark_id AND fragment_index = :fragment_index`,
    );

    for (const repair of repairs) {
      updateGroup.run({
        mark_id: repair.markId,
        source_start_seq: repair.sourceStartSeq,
        source_end_seq: repair.sourceEndSeq,
      });
      for (const fragment of repair.fragments) {
        updateFragment.run({
          mark_id: repair.markId,
          fragment_index: fragment.fragmentIndex,
          source_start_seq: fragment.sourceStartSeq,
          source_end_seq: fragment.sourceEndSeq,
        });
      }
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

await main();
