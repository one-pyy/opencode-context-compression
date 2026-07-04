#!/usr/bin/env node --import tsx
/**
 * Diff a messages.transform hook input against a projected output snapshot.
 *
 * Usage:
 *   node --import tsx scripts/diff-projection-json.ts <hook-in.json> <out.json>
 *   npm run diff-projection -- <hook-in.json> <out.json>
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { renderModelVisiblePartsText } from "../src/model-visible-transcript.js";

const VISIBLE_ID_PATTERN =
  /^\[(protected|compressible|referable)_\d{6}_[0-9A-Za-z]+(?:~(?:protected|compressible|referable)_\d{6}_[0-9A-Za-z]+)?\]\s?/u;
const DEFAULT_SMALL_USER_MESSAGE_THRESHOLD = 1_024;
const LARGE_DIRECT_CONTENT_CHARS = 2_000;

type Role = "system" | "user" | "assistant" | "tool" | "unknown";
type VisibleKind = "protected" | "compressible" | "referable" | "unmarked";
type Severity = "error" | "warning";

interface MessageInfo {
  readonly id?: string;
  readonly role: Role;
  readonly text: string;
  readonly partTypes: readonly string[];
  readonly textChars: number;
  readonly toolLikeChars: number;
  readonly fileLikeChars: number;
  readonly visibleKind: VisibleKind;
}

interface Issue {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
  readonly samples?: readonly unknown[];
}

interface AppliedRange {
  readonly startSeq: number;
  readonly endSeq: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readMessages(path: string): readonly unknown[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    throw new Error(`Expected top-level { messages: [...] } in ${path}`);
  }
  return parsed.messages;
}

function getMessageId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const info = message.info;
  if (isRecord(info) && typeof info.id === "string") return info.id;
  return typeof message.id === "string" ? message.id : undefined;
}

function getRole(message: unknown): Role {
  if (!isRecord(message)) return "unknown";
  const info = message.info;
  const role = isRecord(info) ? info.role : message.role;
  return role === "system" || role === "user" || role === "assistant" || role === "tool"
    ? role
    : "unknown";
}

function getParts(message: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(message) || !Array.isArray(message.parts)) return [];
  return message.parts.filter(isRecord);
}

function partText(part: Record<string, unknown>): string {
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  const state = part.state;
  if (isRecord(state) && typeof state.output === "string") return state.output;
  return "";
}

function classifyVisibleKind(text: string): VisibleKind {
  const match = text.match(VISIBLE_ID_PATTERN);
  if (!match) return "unmarked";
  return match[1] as VisibleKind;
}

function stripVisibleIdPrefix(text: string): string {
  return text.replace(VISIBLE_ID_PATTERN, "").trim();
}

function ensureFallbackId(message: unknown, index: number): unknown {
  if (!isRecord(message) || !isRecord(message.info) || message.info.id) {
    return message;
  }
  return { ...message, info: { ...message.info, id: `msg_${index + 1}` } };
}

function toMessageInfo(message: unknown): MessageInfo {
  const parts = getParts(message);
  const text = renderModelVisiblePartsText(parts as never);
  const partTypes = parts.map((part) =>
    typeof part.type === "string" ? part.type : "unknown",
  );
  const toolLikeChars = parts
    .filter((part) => part.type === "tool" || part.type === "tool_result")
    .reduce((sum, part) => sum + partText(part).length, 0);
  const fileLikeChars = parts.reduce((sum, part) => {
    const textValue = partText(part);
    return textValue.includes("<type>file</type>") ||
      textValue.includes("<type>patch</type>") ||
      textValue.includes("<path>")
      ? sum + textValue.length
      : sum;
  }, 0);

  return {
    id: getMessageId(message),
    role: getRole(message),
    text,
    partTypes,
    textChars: text.length,
    toolLikeChars,
    fileLikeChars,
    visibleKind: classifyVisibleKind(text),
  };
}

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  return values.reduce(
    (counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }),
    {} as Record<T, number>,
  );
}

function sampleMessages(messages: readonly MessageInfo[], limit = 8): readonly unknown[] {
  return messages.slice(0, limit).map((message) => ({
    id: message.id,
    role: message.role,
    chars: message.textChars,
    visibleKind: message.visibleKind,
    text: message.text.slice(0, 140).replace(/\s+/gu, " "),
  }));
}

function stableSnippet(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length >= 120 ? normalized.slice(0, 120) : undefined;
}

function parseArgs(): {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly smallUserMessageThreshold: number;
  readonly dbPath?: string;
} {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.includes("--help") || args.includes("-h")) {
    console.error(
      "Usage: node --import tsx scripts/diff-projection-json.ts <hook-in.json> <out.json> [--db state/session.db] [--small-user-threshold N]",
    );
    process.exit(args.length < 2 ? 1 : 0);
  }

  const thresholdIndex = args.indexOf("--small-user-threshold");
  const dbIndex = args.indexOf("--db");
  const threshold = thresholdIndex >= 0
    ? Number(args[thresholdIndex + 1])
    : DEFAULT_SMALL_USER_MESSAGE_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error("--small-user-threshold must be a positive integer.");
  }

  return {
    inputPath: resolve(args[0]),
    outputPath: resolve(args[1]),
    smallUserMessageThreshold: threshold,
    dbPath: dbIndex >= 0 && args[dbIndex + 1] ? resolve(args[dbIndex + 1]) : undefined,
  };
}

function readAppliedRanges(dbPath: string | undefined): readonly AppliedRange[] {
  if (!dbPath) return [];
  const output = execFileSync(
    "sqlite3",
    [
      dbPath,
      "SELECT rf.source_start_seq || '-' || rf.source_end_seq FROM result_fragments rf JOIN result_groups rg ON rf.mark_id = rg.mark_id WHERE rg.applied = 1 ORDER BY rf.source_start_seq, rf.source_end_seq",
    ],
    { encoding: "utf-8" },
  ).trim();

  if (output.length === 0) return [];
  return output.split("\n").map((line) => {
    const [startSeq, endSeq] = line.split("-").map(Number);
    return { startSeq, endSeq };
  });
}

function isInsideAppliedRange(sequence: number, ranges: readonly AppliedRange[]): boolean {
  return ranges.some((range) =>
    sequence >= range.startSeq && sequence <= range.endSeq,
  );
}

function main(): void {
  const { inputPath, outputPath, smallUserMessageThreshold, dbPath } = parseArgs();
  const inputMessages = readMessages(inputPath).map(ensureFallbackId).map(toMessageInfo);
  const outputMessages = readMessages(outputPath).map(ensureFallbackId).map(toMessageInfo);
  const inputIds = new Set(inputMessages.map((message) => message.id).filter(Boolean));
  const outputIds = new Set(outputMessages.map((message) => message.id).filter(Boolean));
  const outputText = outputMessages.map((message) => message.text.replace(/\s+/gu, " ")).join("\n");
  const appliedRanges = readAppliedRanges(dbPath);

  const inputUserText = inputMessages.filter(
    (message) => message.role === "user" && message.partTypes.includes("text") && message.text.trim().length > 0,
  );
  const shortUserMessages = inputUserText.filter(
    (message) => message.textChars <= smallUserMessageThreshold,
  );
  const longUserMessages = inputUserText.filter(
    (message) => message.textChars > smallUserMessageThreshold,
  );
  const missingShortUsers = shortUserMessages.filter(
    (message) => !message.id || !outputIds.has(message.id),
  );
  const preservedLongUsers = longUserMessages.filter(
    (message) => message.id && outputIds.has(message.id),
  );
  const potentialLongUserLeaks = longUserMessages.filter((message) => {
    const snippet = stableSnippet(message.text);
    return snippet !== undefined && outputText.includes(snippet);
  });
  const outputNonEmptyMessages = outputMessages.filter(
    (message) => message.text.trim().length > 0,
  );
  const directLargeOutputs = outputMessages
    .filter(
      (message) =>
        message.toolLikeChars >= LARGE_DIRECT_CONTENT_CHARS ||
        message.fileLikeChars >= LARGE_DIRECT_CONTENT_CHARS,
    )
    .sort((left, right) =>
      Math.max(right.toolLikeChars, right.fileLikeChars) -
      Math.max(left.toolLikeChars, left.fileLikeChars),
    );

  const duplicateOutputIds = [...outputIds].filter(
    (id) => outputMessages.filter((message) => message.id === id).length > 1,
  );
  const inputMessagesWithSequence = inputMessages.map((message, index) => ({
    message,
    sequence: index + 1,
  }));
  const missingOriginalMessages = inputMessagesWithSequence.filter(
    ({ message }) => message.id !== undefined && !outputIds.has(message.id),
  );
  const missingOutsideAppliedRanges = appliedRanges.length === 0
    ? []
    : missingOriginalMessages.filter(
      ({ sequence }) => !isInsideAppliedRange(sequence, appliedRanges),
    );
  const missingToolMessages = inputMessagesWithSequence.filter(
    ({ message }) =>
      message.id !== undefined &&
      !outputIds.has(message.id) &&
      message.partTypes.some((partType) => partType === "tool" || partType === "tool_result"),
  );
  const missingToolMessagesOutsideAppliedRanges = appliedRanges.length === 0
    ? []
    : missingToolMessages.filter(
      ({ sequence }) => !isInsideAppliedRange(sequence, appliedRanges),
    );
  const missingReasoningMessages = inputMessagesWithSequence.filter(
    ({ message }) =>
      message.id !== undefined &&
      !outputIds.has(message.id) &&
      message.partTypes.includes("reasoning"),
  );
  const missingReasoningOutsideAppliedRanges = appliedRanges.length === 0
    ? []
    : missingReasoningMessages.filter(
      ({ sequence }) => !isInsideAppliedRange(sequence, appliedRanges),
    );
  const EXPECTED_PHANTOM_PREFIXES = ["referable_", "synthetic-"];
  const phantomOutputMessages = outputMessages.filter(
    (message) =>
      message.id !== undefined &&
      !inputIds.has(message.id) &&
      !EXPECTED_PHANTOM_PREFIXES.some((prefix) => (message.id as string).startsWith(prefix)),
  );
  const outputById = new Map(
    outputMessages
      .filter((message) => message.id !== undefined)
      .map((message) => [message.id as string, message] as const),
  );
  const contentMismatches: Array<{
    readonly id: string;
    readonly inputChars: number;
    readonly outputChars: number;
    readonly inputSnippet: string;
    readonly outputSnippet: string;
  }> = [];
  for (const inMsg of inputMessages) {
    if (inMsg.id === undefined) continue;
    const outMsg = outputById.get(inMsg.id);
    if (outMsg === undefined) continue;
    if (outMsg.visibleKind === "referable") continue;
    const inText = stripVisibleIdPrefix(inMsg.text);
    const outText = stripVisibleIdPrefix(outMsg.text);
    if (inText.length > 0 && outText.length > 0 && inText !== outText) {
      contentMismatches.push({
        id: inMsg.id,
        inputChars: inText.length,
        outputChars: outText.length,
        inputSnippet: inText.slice(0, 120).replace(/\s+/gu, " "),
        outputSnippet: outText.slice(0, 120).replace(/\s+/gu, " "),
      });
    }
  }
  const issues: Issue[] = [];
  if (missingShortUsers.length > 0) {
    issues.push({
      severity: "error",
      code: "SHORT_USER_MESSAGE_MISSING",
      message: `${missingShortUsers.length} short user messages are missing from output by original message id.`,
      samples: sampleMessages(missingShortUsers),
    });
  }
  if (duplicateOutputIds.length > 0) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_OUTPUT_MESSAGE_ID",
      message: `${duplicateOutputIds.length} output message ids appear more than once.`,
      samples: duplicateOutputIds.slice(0, 10),
    });
  }
  if (missingOutsideAppliedRanges.length > 0) {
    issues.push({
      severity: "error",
      code: "ORIGINAL_MESSAGE_MISSING_OUTSIDE_APPLIED_RANGE",
      message: `${missingOutsideAppliedRanges.length} original messages are missing even though their input sequence is outside applied result-fragment ranges.`,
      samples: sampleMessages(missingOutsideAppliedRanges.map(({ message }) => message)),
    });
  }
  if (missingToolMessagesOutsideAppliedRanges.length > 0) {
    issues.push({
      severity: "error",
      code: "TOOL_RESULT_MISSING_OUTSIDE_APPLIED_RANGE",
      message: `${missingToolMessagesOutsideAppliedRanges.length} tool/tool_result messages are missing outside applied result-fragment ranges.`,
      samples: sampleMessages(missingToolMessagesOutsideAppliedRanges.map(({ message }) => message)),
    });
  }
  if (missingReasoningOutsideAppliedRanges.length > 0) {
    issues.push({
      severity: "warning",
      code: "REASONING_MISSING_OUTSIDE_APPLIED_RANGE",
      message: `${missingReasoningOutsideAppliedRanges.length} reasoning messages are missing outside applied result-fragment ranges.`,
      samples: sampleMessages(missingReasoningOutsideAppliedRanges.map(({ message }) => message)),
    });
  }
  if (potentialLongUserLeaks.length > 0) {
    issues.push({
      severity: "warning",
      code: "LONG_USER_TEXT_STILL_PRESENT",
      message: `${potentialLongUserLeaks.length} long user messages have large snippets still present in output. This can be valid if they were not inside an applied mark.`,
      samples: sampleMessages(potentialLongUserLeaks),
    });
  }
  if (directLargeOutputs.length > 0) {
    issues.push({
      severity: "warning",
      code: "LARGE_TOOL_OR_FILE_CONTENT_PRESENT",
      message: `${directLargeOutputs.length} output messages still contain direct tool/file content >= ${LARGE_DIRECT_CONTENT_CHARS} chars.`,
      samples: sampleMessages(directLargeOutputs),
    });
  }
  if (phantomOutputMessages.length > 0) {
    issues.push({
      severity: "error",
      code: "PHANTOM_OUTPUT_MESSAGE",
      message: `${phantomOutputMessages.length} output messages have ids that do not exist in input and are not referable/synthetic replacements.`,
      samples: sampleMessages(phantomOutputMessages),
    });
  }
  if (contentMismatches.length > 0) {
    issues.push({
      severity: "warning",
      code: "CONTENT_MISMATCH",
      message: `${contentMismatches.length} preserved messages have different content after stripping visible id prefixes.`,
      samples: contentMismatches.slice(0, 8),
    });
  }

  const result = {
    input: {
      file: inputPath,
      messages: inputMessages.length,
      roles: countBy(inputMessages.map((message) => message.role)),
      partTypes: countBy(inputMessages.flatMap((message) => message.partTypes)),
      userTextMessages: inputUserText.length,
      shortUserMessages: shortUserMessages.length,
      longUserMessages: longUserMessages.length,
    },
    output: {
      file: outputPath,
      messages: outputMessages.length,
      nonEmptyMessages: outputNonEmptyMessages.length,
      emptyTextMessages: outputMessages.length - outputNonEmptyMessages.length,
      roles: countBy(outputMessages.map((message) => message.role)),
      partTypes: countBy(outputMessages.flatMap((message) => message.partTypes)),
      visibleKinds: countBy(outputNonEmptyMessages.map((message) => message.visibleKind)),
      directToolLikeChars: outputMessages.reduce((sum, message) => sum + message.toolLikeChars, 0),
      directFileLikeChars: outputMessages.reduce((sum, message) => sum + message.fileLikeChars, 0),
    },
    preservation: {
      smallUserMessageThreshold,
      shortUserPreservedByOriginalId: shortUserMessages.length - missingShortUsers.length,
      shortUserMissingByOriginalId: missingShortUsers.length,
      longUserPreservedByOriginalId: preservedLongUsers.length,
      longUserCompressedOrRemoved: longUserMessages.length - preservedLongUsers.length,
      appliedRangeCheck: dbPath
        ? {
            db: dbPath,
            appliedResultFragmentRanges: appliedRanges.length,
            missingOriginalMessages: missingOriginalMessages.length,
            missingOriginalMessagesOutsideAppliedRanges: missingOutsideAppliedRanges.length,
            missingToolMessages: missingToolMessages.length,
            missingToolMessagesOutsideAppliedRanges: missingToolMessagesOutsideAppliedRanges.length,
            missingReasoningMessages: missingReasoningMessages.length,
            missingReasoningOutsideAppliedRanges: missingReasoningOutsideAppliedRanges.length,
          }
        : undefined,
    },
    reductions: {
      messageDelta: outputMessages.length - inputMessages.length,
      messageReductionRatio: inputMessages.length === 0
        ? null
        : Number((1 - outputMessages.length / inputMessages.length).toFixed(4)),
    },
    issues,
  };

  console.log(JSON.stringify(result, null, 2));
}

main();
