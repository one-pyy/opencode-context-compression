#!/usr/bin/env node --import tsx
/**
 * Batch-repair result group/fragment source sequences using OpenCode history.
 *
 * This script does not change schema. It only rewrites source_start_seq /
 * source_end_seq for result_groups and result_fragments that can be proven to
 * be legacy replay coordinates for the same compression_mark canonical range.
 *
 * Dry-run by default. Use --apply to write changes after creating DB backups.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface Args {
  readonly apply: boolean;
  readonly stateDir: string;
  readonly backupDir: string;
  readonly opencodeDbPath: string;
  readonly reportPath: string;
  readonly sessionId?: string;
}

interface MessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly data: string;
  readonly time_created?: number | string;
}

interface PartRow {
  readonly id: string;
  readonly message_id: string;
  readonly session_id: string;
  readonly data: string;
  readonly time_created?: number | string;
}

interface MessageData {
  readonly id: string;
  readonly role?: string;
  readonly sessionID?: string;
}

interface ToolPartData {
  readonly type?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly state?: {
    readonly status?: string;
    readonly input?: {
      readonly from?: string;
      readonly to?: string;
    };
    readonly output?: string;
  };
}

interface LoadedMessage {
  readonly info: MessageData;
  readonly parts: readonly LoadedPart[];
  readonly timeCreated?: number | string;
}

interface LoadedPart extends ToolPartData {
  readonly id: string;
  readonly messageID: string;
}

interface MarkInput {
  readonly from: string;
  readonly to: string;
  readonly messageID: string;
}

interface Timelines {
  readonly currentSeqToCanonicalId: ReadonlyMap<number, string>;
  readonly currentCanonicalIdToSeq: ReadonlyMap<string, number>;
  readonly oldSeqToCanonicalId: ReadonlyMap<number, string>;
  readonly syntheticSlots: number;
}

interface ResultGroupRow {
  readonly mark_id: string;
  readonly source_start_seq: number;
  readonly source_end_seq: number;
}

interface ResultFragmentRow {
  readonly mark_id: string;
  readonly fragment_index: number;
  readonly source_start_seq: number;
  readonly source_end_seq: number;
}

interface Range {
  readonly startSeq: number;
  readonly endSeq: number;
  readonly startCanonicalId: string;
  readonly endCanonicalId: string;
}

interface GroupRepair {
  readonly markId: string;
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
  readonly fragments: readonly FragmentRepair[];
}

interface FragmentRepair {
  readonly fragmentIndex: number;
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
}

interface SessionReport {
  readonly sessionId: string;
  readonly status: "current-correct" | "legacy-seq-repairable" | "unsafe" | "missing-message-source";
  readonly groups: number;
  readonly fragments: number;
  readonly syntheticSlots?: number;
  readonly repairs?: number;
  readonly fragmentRepairs?: number;
  readonly reasons?: readonly string[];
  readonly title?: string;
  readonly firstUserMessage?: string;
  readonly timeRange?: string;
  readonly estimatedTokens?: number;
}

const root = resolve(new URL("..", import.meta.url).pathname);
const replayablePluginTools = new Set([
  "compression_mark",
  "compression_inspect",
  "compression_recall",
]);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sessionIds = listSessionIds(args);
  const reports: SessionReport[] = [];
  let appliedSessions = 0;
  let appliedGroups = 0;
  let appliedFragments = 0;

  for (const sessionId of sessionIds) {
    const result = analyzeSession(args, sessionId);
    reports.push(result.report);
    if (!args.apply || result.report.status !== "legacy-seq-repairable") {
      continue;
    }
    backupSessionDb(args, sessionId);
    applyRepairs(join(args.stateDir, `${sessionId}.db`), result.repairs);
    appliedSessions += 1;
    appliedGroups += result.repairs.length;
    appliedFragments += result.repairs.reduce(
      (sum, repair) => sum + repair.fragments.length,
      0,
    );
  }

  writeReport(args.reportPath, args, reports);
  console.log(JSON.stringify(buildSummary(args, reports, {
    sessions: appliedSessions,
    groups: appliedGroups,
    fragments: appliedFragments,
  }), null, 2));
}

function parseArgs(argv: readonly string[]): Args {
  const stateDir = resolve(readFlag(argv, "--state-dir") ?? join(root, "state"));
  return {
    apply: argv.includes("--apply"),
    stateDir,
    backupDir: resolve(
      readFlag(argv, "--backup-dir") ??
        join(root, ".bak", "db-20260705-before-seq-repair-batch"),
    ),
    opencodeDbPath: resolve(
      readFlag(argv, "--opencode-db") ?? "/root/.local/share/opencode/opencode.db",
    ),
    reportPath: resolve(
      readFlag(argv, "--report") ??
        join(root, ".sisyphus", "tmp", "work", "seq-repair-batch-report-2026-07-05.md"),
    ),
    sessionId: readFlag(argv, "--session"),
  };
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function listSessionIds(args: Args): readonly string[] {
  if (args.sessionId !== undefined) {
    return [args.sessionId];
  }
  return readdirSync(args.stateDir)
    .filter((file) => file.startsWith("ses_") && file.endsWith(".db"))
    .map((file) => file.slice(0, -3))
    .sort();
}

function analyzeSession(
  args: Args,
  sessionId: string,
): { readonly report: SessionReport; readonly repairs: readonly GroupRepair[] } {
  const dbPath = join(args.stateDir, `${sessionId}.db`);
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (!hasTable(database, "result_groups")) {
      return { report: { sessionId, status: "current-correct", groups: 0, fragments: 0 }, repairs: [] };
    }
    const groups = database
      .prepare("SELECT mark_id, source_start_seq, source_end_seq FROM result_groups ORDER BY mark_id")
      .all() as unknown as ResultGroupRow[];
    if (groups.length === 0) {
      return { report: { sessionId, status: "current-correct", groups: 0, fragments: 0 }, repairs: [] };
    }

    const history = loadOpenCodeHistory(args, sessionId);
    const diagnostic = buildDiagnostic(history.messages);
    if (history.messages.length === 0) {
      return {
        report: {
          sessionId,
          status: "missing-message-source",
          groups: groups.length,
          fragments: countFragments(database),
          ...diagnostic,
          reasons: ["missing OpenCode message rows"],
        },
        repairs: [],
      };
    }

    const timelines = buildTimelines(history.messages);
    const repairs: GroupRepair[] = [];
    const reasons = new Set<string>();
    let fragments = 0;
    let fragmentRepairs = 0;

    for (const group of groups) {
      const mark = history.marksById.get(group.mark_id);
      if (mark === undefined) {
        reasons.add(`missing compression_mark tool for ${group.mark_id}`);
        continue;
      }
      const markRange = resolveMarkRange(database, mark, timelines);
      if (markRange === undefined) {
        reasons.add(`could not resolve mark range for ${group.mark_id}`);
        continue;
      }

      const groupRange = classifyRange(group.source_start_seq, group.source_end_seq, markRange, timelines);
      if (groupRange === undefined) {
        reasons.add(`group range does not match mark range for ${group.mark_id}`);
        continue;
      }

      const fragmentRows = database
        .prepare("SELECT mark_id, fragment_index, source_start_seq, source_end_seq FROM result_fragments WHERE mark_id = ? ORDER BY fragment_index")
        .all(group.mark_id) as unknown as ResultFragmentRow[];
      fragments += fragmentRows.length;

      const fragmentRepairsForGroup: FragmentRepair[] = [];
      let unsafeFragment = false;
      for (const fragment of fragmentRows) {
        const fragmentRange = classifyFragmentRange(
          fragment.source_start_seq,
          fragment.source_end_seq,
          markRange,
          timelines,
        );
        if (fragmentRange === undefined) {
          reasons.add(`fragment range outside mark range for ${group.mark_id}:${fragment.fragment_index}`);
          unsafeFragment = true;
          break;
        }
        if (fragmentRange.needsRepair) {
          fragmentRepairs += 1;
        }
        fragmentRepairsForGroup.push({
          fragmentIndex: fragment.fragment_index,
          sourceStartSeq: fragmentRange.range.startSeq,
          sourceEndSeq: fragmentRange.range.endSeq,
        });
      }
      if (unsafeFragment) {
        continue;
      }

      if (groupRange.needsRepair || fragmentRepairsForGroup.some((repair, index) => {
        const original = fragmentRows[index];
        return repair.sourceStartSeq !== original.source_start_seq || repair.sourceEndSeq !== original.source_end_seq;
      })) {
        repairs.push({
          markId: group.mark_id,
          sourceStartSeq: groupRange.range.startSeq,
          sourceEndSeq: groupRange.range.endSeq,
          fragments: fragmentRepairsForGroup,
        });
      }
    }

    if (reasons.size > 0) {
      return {
        report: {
          sessionId,
          status: "unsafe",
          groups: groups.length,
          fragments,
          syntheticSlots: timelines.syntheticSlots,
          reasons: [...reasons].sort(),
          ...diagnostic,
        },
        repairs: [],
      };
    }

    if (repairs.length === 0) {
      return {
        report: {
          sessionId,
          status: "current-correct",
          groups: groups.length,
          fragments,
          syntheticSlots: timelines.syntheticSlots,
        },
        repairs: [],
      };
    }

    return {
      report: {
        sessionId,
        status: "legacy-seq-repairable",
        groups: groups.length,
        fragments,
        syntheticSlots: timelines.syntheticSlots,
        repairs: repairs.length,
        fragmentRepairs,
      },
      repairs,
    };
  } finally {
    database.close();
  }
}

function hasTable(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { readonly count: number };
  return row.count > 0;
}

function countFragments(database: DatabaseSync): number {
  if (!hasTable(database, "result_fragments")) {
    return 0;
  }
  const row = database.prepare("SELECT count(*) AS count FROM result_fragments").get() as {
    readonly count: number;
  };
  return row.count;
}

function loadOpenCodeHistory(args: Args, sessionId: string): {
  readonly messages: readonly LoadedMessage[];
  readonly marksById: ReadonlyMap<string, MarkInput>;
} {
  const database = new DatabaseSync(args.opencodeDbPath, { readOnly: true });
  try {
    const messageRows = database
      .prepare("SELECT id, session_id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
      .all(sessionId) as unknown as MessageRow[];
    const partRows = database
      .prepare("SELECT id, message_id, session_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC")
      .all(sessionId) as unknown as PartRow[];

    const partsByMessage = new Map<string, LoadedPart[]>();
    const marksById = new Map<string, MarkInput>();
    for (const row of partRows) {
      const parsed = JSON.parse(row.data) as ToolPartData;
      const part: LoadedPart = { ...parsed, id: row.id, messageID: row.message_id };
      const list = partsByMessage.get(row.message_id) ?? [];
      list.push(part);
      partsByMessage.set(row.message_id, list);
      const mark = parseMarkToolPart(part);
      if (mark !== undefined) {
        marksById.set(mark.markId, {
          from: mark.from,
          to: mark.to,
          messageID: row.message_id,
        });
      }
    }

    return {
      messages: messageRows.map((row) => ({
        info: { ...(JSON.parse(row.data) as MessageData), id: row.id },
        parts: partsByMessage.get(row.id) ?? [],
        timeCreated: row.time_created,
      })),
      marksById,
    };
  } finally {
    database.close();
  }
}

function parseMarkToolPart(part: LoadedPart):
  | { readonly markId: string; readonly from: string; readonly to: string }
  | undefined {
  if (part.type !== "tool" || part.tool !== "compression_mark" || part.state?.status !== "completed") {
    return undefined;
  }
  const output = parseToolOutput(part.state.output);
  const markId = output?.markId;
  const from = part.state.input?.from;
  const to = part.state.input?.to;
  if (typeof markId !== "string" || typeof from !== "string" || typeof to !== "string") {
    return undefined;
  }
  return { markId, from, to };
}

function parseToolOutput(output: string | undefined): { readonly markId?: string } | undefined {
  if (output === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(output) as { readonly markId?: string };
  } catch {
    return undefined;
  }
}

function buildDiagnostic(messages: readonly LoadedMessage[]): Pick<SessionReport, "title" | "firstUserMessage" | "timeRange" | "estimatedTokens"> {
  const firstUser = messages.find((message) => message.info.role === "user");
  const firstUserText = firstUser === undefined ? undefined : extractMessageText(firstUser);
  const text = messages.map(extractMessageText).join("\n").trim();
  return {
    title: firstUserText?.split("\n")[0]?.slice(0, 120),
    firstUserMessage: firstUserText?.slice(0, 500),
    timeRange: buildTimeRange(messages),
    estimatedTokens: text.length === 0 ? undefined : Math.ceil(text.length / 4),
  };
}

function extractMessageText(message: LoadedMessage): string {
  return message.parts
    .map((part) => {
      if (typeof part.text === "string") {
        return part.text;
      }
      const payload = part.state?.input ?? part.state?.output;
      return payload === undefined ? "" : JSON.stringify(payload);
    })
    .filter((text) => text.trim().length > 0)
    .join("\n")
    .trim();
}

function buildTimeRange(messages: readonly LoadedMessage[]): string | undefined {
  const values = messages.map((message) => message.timeCreated).filter((value) => value !== undefined);
  if (values.length === 0) {
    return undefined;
  }
  return `${String(values[0])}..${String(values[values.length - 1])}`;
}

function buildTimelines(messages: readonly LoadedMessage[]): Timelines {
  const currentSeqToCanonicalId = new Map<number, string>();
  const currentCanonicalIdToSeq = new Map<string, number>();
  let currentSeq = 1;
  for (const message of messages) {
    if (!isHostRole(message.info.role)) {
      continue;
    }
    currentSeqToCanonicalId.set(currentSeq, message.info.id);
    currentCanonicalIdToSeq.set(message.info.id, currentSeq);
    currentSeq += 1;
  }

  const oldSeqToCanonicalId = new Map<number, string>();
  let oldSeq = 1;
  let syntheticSlots = 0;
  for (const message of messages) {
    if (!isHostRole(message.info.role)) {
      continue;
    }
    oldSeqToCanonicalId.set(oldSeq, message.info.id);
    oldSeq += 1;
    for (const part of message.parts) {
      if (isReplayableCompletedPluginTool(part)) {
        oldSeqToCanonicalId.set(oldSeq, message.info.id);
        oldSeq += 1;
        syntheticSlots += 1;
      }
    }
  }

  return { currentSeqToCanonicalId, currentCanonicalIdToSeq, oldSeqToCanonicalId, syntheticSlots };
}

function isHostRole(role: string | undefined): boolean {
  return role === "system" || role === "user" || role === "assistant" || role === "tool";
}

function isReplayableCompletedPluginTool(part: LoadedPart): boolean {
  return part.type === "tool" &&
    part.state?.status === "completed" &&
    part.tool !== undefined &&
    replayablePluginTools.has(part.tool);
}

function resolveMarkRange(
  database: DatabaseSync,
  mark: MarkInput,
  timelines: Timelines,
): Range | undefined {
  const startCanonicalId = resolveVisibleId(database, mark.from);
  const endCanonicalId = resolveVisibleId(database, mark.to);
  if (startCanonicalId === undefined || endCanonicalId === undefined) {
    return undefined;
  }
  const startSeq = timelines.currentCanonicalIdToSeq.get(startCanonicalId);
  const endSeq = timelines.currentCanonicalIdToSeq.get(endCanonicalId);
  if (startSeq === undefined || endSeq === undefined || startSeq > endSeq) {
    return undefined;
  }
  return { startSeq, endSeq, startCanonicalId, endCanonicalId };
}

function resolveVisibleId(database: DatabaseSync, visibleId: string): string | undefined {
  const parsed = parseVisibleId(visibleId);
  if (parsed === undefined || !hasTable(database, "visible_sequence_allocations")) {
    return undefined;
  }
  const row = database
    .prepare("SELECT canonical_id FROM visible_sequence_allocations WHERE visible_seq = ? AND visible_base62 = ?")
    .get(parsed.seq, parsed.base62) as { readonly canonical_id?: string } | undefined;
  return row?.canonical_id;
}

function parseVisibleId(visibleId: string): { readonly seq: number; readonly base62: string } | undefined {
  const match = visibleId.match(/^[a-z]+_(\d{6})_([A-Za-z0-9]+)$/);
  if (match === null) {
    return undefined;
  }
  return { seq: Number(match[1]), base62: match[2] };
}

function classifyRange(
  startSeq: number,
  endSeq: number,
  markRange: Range,
  timelines: Timelines,
): { readonly needsRepair: boolean; readonly range: Range } | undefined {
  const current = currentRange(startSeq, endSeq, timelines);
  if (sameRange(current, markRange)) {
    return { needsRepair: false, range: current };
  }
  const legacy = oldRange(startSeq, endSeq, timelines);
  if (sameRange(legacy, markRange)) {
    return { needsRepair: true, range: legacy };
  }
  return undefined;
}

function classifyFragmentRange(
  startSeq: number,
  endSeq: number,
  markRange: Range,
  timelines: Timelines,
): { readonly needsRepair: boolean; readonly range: Range } | undefined {
  const current = currentRange(startSeq, endSeq, timelines);
  if (rangeInside(current, markRange)) {
    return { needsRepair: false, range: current };
  }
  const legacy = oldRange(startSeq, endSeq, timelines);
  if (rangeInside(legacy, markRange)) {
    return { needsRepair: true, range: legacy };
  }
  return undefined;
}

function currentRange(startSeq: number, endSeq: number, timelines: Timelines): Range | undefined {
  if (startSeq > endSeq) {
    return undefined;
  }
  const startCanonicalId = timelines.currentSeqToCanonicalId.get(startSeq);
  const endCanonicalId = timelines.currentSeqToCanonicalId.get(endSeq);
  if (startCanonicalId === undefined || endCanonicalId === undefined) {
    return undefined;
  }
  return { startSeq, endSeq, startCanonicalId, endCanonicalId };
}

function oldRange(startSeq: number, endSeq: number, timelines: Timelines): Range | undefined {
  if (startSeq > endSeq) {
    return undefined;
  }
  const startCanonicalId = timelines.oldSeqToCanonicalId.get(startSeq);
  const endCanonicalId = timelines.oldSeqToCanonicalId.get(endSeq);
  if (startCanonicalId === undefined || endCanonicalId === undefined) {
    return undefined;
  }
  const mappedStartSeq = timelines.currentCanonicalIdToSeq.get(startCanonicalId);
  const mappedEndSeq = timelines.currentCanonicalIdToSeq.get(endCanonicalId);
  if (mappedStartSeq === undefined || mappedEndSeq === undefined || mappedStartSeq > mappedEndSeq) {
    return undefined;
  }
  return { startSeq: mappedStartSeq, endSeq: mappedEndSeq, startCanonicalId, endCanonicalId };
}

function sameRange(left: Range | undefined, right: Range): left is Range {
  return left !== undefined &&
    left.startCanonicalId === right.startCanonicalId &&
    left.endCanonicalId === right.endCanonicalId;
}

function rangeInside(inner: Range | undefined, outer: Range): inner is Range {
  return inner !== undefined && inner.startSeq >= outer.startSeq && inner.endSeq <= outer.endSeq;
}

function backupSessionDb(args: Args, sessionId: string): void {
  mkdirSync(args.backupDir, { recursive: true });
  const source = join(args.stateDir, `${sessionId}.db`);
  const target = join(args.backupDir, `${sessionId}.db`);
  if (!existsSync(target)) {
    copyFileSync(source, target);
  }
}

function applyRepairs(dbPath: string, repairs: readonly GroupRepair[]): void {
  const database = new DatabaseSync(dbPath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const updateGroup = database.prepare(
      `UPDATE result_groups
       SET source_start_seq = ?, source_end_seq = ?
       WHERE mark_id = ?`,
    );
    const updateFragment = database.prepare(
      `UPDATE result_fragments
       SET source_start_seq = ?, source_end_seq = ?
       WHERE mark_id = ? AND fragment_index = ?`,
    );
    for (const repair of repairs) {
      updateGroup.run(repair.sourceStartSeq, repair.sourceEndSeq, repair.markId);
      for (const fragment of repair.fragments) {
        updateFragment.run(
          fragment.sourceStartSeq,
          fragment.sourceEndSeq,
          repair.markId,
          fragment.fragmentIndex,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function writeReport(reportPath: string, args: Args, reports: readonly SessionReport[]): void {
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  const unsafe = reports.filter((report) =>
    report.status === "unsafe" || report.status === "missing-message-source"
  );
  const summary = buildSummary(args, reports, { sessions: 0, groups: 0, fragments: 0 });
  const lines = [
    "# Seq Repair Batch Report",
    "",
    `Mode: ${args.apply ? "apply" : "dry-run"}`,
    `State: ${args.stateDir}`,
    `Backup: ${args.backupDir}`,
    "",
    "## Summary",
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
    "## Unsafe Or Missing",
    "",
  ];
  for (const report of unsafe) {
    lines.push(
      `### ${report.sessionId}`,
      "",
      `Status: ${report.status}`,
      `Groups: ${report.groups}`,
      `Fragments: ${report.fragments}`,
      `Estimated tokens: ${report.estimatedTokens ?? "unknown"}`,
      `Time: ${report.timeRange ?? "unknown"}`,
      `Title: ${report.title ?? "unknown"}`,
      `Reason: ${(report.reasons ?? []).join("; ") || "unknown"}`,
      "",
      "First user message:",
      "",
      "```text",
      report.firstUserMessage ?? "unknown",
      "```",
      "",
    );
  }
  writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf-8");
}

function buildSummary(
  args: Args,
  reports: readonly SessionReport[],
  applied: { readonly sessions: number; readonly groups: number; readonly fragments: number },
): Record<string, unknown> {
  const counts = new Map<string, number>();
  for (const report of reports) {
    counts.set(report.status, (counts.get(report.status) ?? 0) + 1);
  }
  const repairable = reports.filter((report) => report.status === "legacy-seq-repairable");
  return {
    mode: args.apply ? "apply" : "dry-run",
    totalSessionsScanned: reports.length,
    statusCounts: Object.fromEntries([...counts.entries()].sort()),
    repairableGroups: repairable.reduce((sum, report) => sum + report.groups, 0),
    repairableFragments: repairable.reduce((sum, report) => sum + report.fragments, 0),
    repairsPlanned: repairable.reduce((sum, report) => sum + (report.repairs ?? 0), 0),
    fragmentRepairsPlanned: repairable.reduce((sum, report) => sum + (report.fragmentRepairs ?? 0), 0),
    applied,
    reportPath: args.reportPath,
  };
}

await main();
