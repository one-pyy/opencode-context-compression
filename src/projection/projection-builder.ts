import type {
  ReplacementMarkLinkRecord,
  ReplacementRecord,
  SourceSnapshotMessageRecord,
  SqliteSessionStateStore,
} from "../state/store.js";
import { ensureReferableVisibleMessageIdentity } from "../identity/visible-sequence.js";
import type { TransformEnvelope, TransformMessage, TransformPart } from "../seams/noop-observation.js";
import { buildProjectionPolicy, type ProjectionPolicy, type ProjectionVisibleState } from "./policy-engine.js";
import { deriveReminder, type DerivedReminder, type ReminderCadence } from "./reminder-service.js";

const LEGACY_ROLE_PREFIX_PATTERN = /^(?:assistant|user|tool)_/;

export interface ProjectionBuilderOptions {
  readonly messages: readonly TransformEnvelope[];
  readonly store: SqliteSessionStateStore;
  readonly reminderCadence?: ReminderCadence;
}

export interface ProjectionBuildResult {
  readonly projectedMessages: readonly TransformEnvelope[];
  readonly policy: ProjectionPolicy;
  readonly reminder?: DerivedReminder;
  readonly appliedReplacementIDs: readonly string[];
  readonly hiddenToolCallMessageIDs: readonly string[];
}

interface AppliedReplacementSpan {
  readonly replacement: ReplacementRecord;
  readonly sourceMessages: readonly SourceSnapshotMessageRecord[];
  readonly links: readonly ReplacementMarkLinkRecord[];
  readonly hiddenToolCallMessageIDs: readonly string[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly visibleMessageID: string;
}

export function buildProjectedMessages(options: ProjectionBuilderOptions): ProjectionBuildResult {
  const policy = buildProjectionPolicy({
    messages: options.messages,
    store: options.store,
  });
  const reminder = deriveReminder({
    policy,
    cadence: options.reminderCadence,
  });
  const appliedSpans = collectAppliedReplacementSpans(policy, options.store);
  const spanByStartIndex = new Map(appliedSpans.map((span) => [span.startIndex, span]));
  const hiddenToolCallMessageIDs = new Set(appliedSpans.flatMap((span) => span.hiddenToolCallMessageIDs));
  const projectedMessages: TransformEnvelope[] = [];
  let reminderInserted = false;

  for (let index = 0; index < policy.messages.length; ) {
    const message = policy.messages[index];
    if (message === undefined) {
      break;
    }

    if (hiddenToolCallMessageIDs.has(message.identity.hostMessageID)) {
      index += 1;
      continue;
    }

    const span = spanByStartIndex.get(index);
    if (span !== undefined) {
      projectedMessages.push(renderAppliedReplacement(span, policy));

      if (
        reminder !== undefined &&
        !reminderInserted &&
        reminder.anchorIndex >= span.startIndex &&
        reminder.anchorIndex <= span.endIndex
      ) {
        projectedMessages.push(renderReminder(reminder, policy));
        reminderInserted = true;
      }

      index = span.endIndex + 1;
      continue;
    }

    projectedMessages.push(renderCanonicalMessage(message.envelope, message.visibleState, message.visible.visibleMessageID));
    if (
      reminder !== undefined &&
      !reminderInserted &&
      reminder.anchorHostMessageID === message.identity.hostMessageID
    ) {
      projectedMessages.push(renderReminder(reminder, policy));
      reminderInserted = true;
    }

    index += 1;
  }

  if (reminder !== undefined && !reminderInserted) {
    projectedMessages.push(renderReminder(reminder, policy));
  }

  return {
    projectedMessages,
    policy,
    reminder,
    appliedReplacementIDs: appliedSpans.map((span) => span.replacement.replacementID),
    hiddenToolCallMessageIDs: [...hiddenToolCallMessageIDs].sort(),
  };
}

function collectAppliedReplacementSpans(
  policy: ProjectionPolicy,
  store: SqliteSessionStateStore,
): AppliedReplacementSpan[] {
  const candidates: AppliedReplacementSpan[] = [];
  const seenReplacementIDs = new Set<string>();

  for (const mark of store.listMarks().filter((mark) => mark.status !== "invalid")) {
    const replacement = store.findFirstCommittedReplacementForMark(mark.markID);
    if (replacement === undefined || seenReplacementIDs.has(replacement.replacementID)) {
      continue;
    }

    const candidate = createAppliedReplacementSpan(replacement, policy, store);
    if (candidate === undefined) {
      continue;
    }

    seenReplacementIDs.add(replacement.replacementID);
    candidates.push(candidate);
  }

  candidates.sort(
    (left, right) =>
      left.startIndex - right.startIndex ||
      left.replacement.committedAtMs - right.replacement.committedAtMs ||
      left.replacement.replacementID.localeCompare(right.replacement.replacementID),
  );

  const occupiedIndexes = new Set<number>();
  const selected: AppliedReplacementSpan[] = [];
  for (const candidate of candidates) {
    if (rangeOverlaps(candidate.startIndex, candidate.endIndex, occupiedIndexes)) {
      continue;
    }

    selected.push(candidate);
    for (let index = candidate.startIndex; index <= candidate.endIndex; index += 1) {
      occupiedIndexes.add(index);
    }
  }

  return selected;
}

function createAppliedReplacementSpan(
  replacement: ReplacementRecord,
  policy: ProjectionPolicy,
  store: SqliteSessionStateStore,
): AppliedReplacementSpan | undefined {
  if (replacement.status !== "committed" || replacement.invalidatedAtMs !== undefined) {
    return undefined;
  }

  const sourceMessages = store.listReplacementSourceMessages(replacement.replacementID);
  if (sourceMessages.length === 0) {
    return undefined;
  }

  const sourcePolicyMessages: Array<ProjectionPolicy["messages"][number]> = [];
  for (const sourceMessage of sourceMessages) {
    const projectedMessage = policy.byHostMessageID.get(sourceMessage.hostMessageID);
    if (projectedMessage === undefined) {
      return undefined;
    }

    if (
      projectedMessage.identity.canonicalMessageID !== sourceMessage.canonicalMessageID ||
      projectedMessage.identity.role !== sourceMessage.hostRole ||
      projectedMessage.visibleState === "protected"
    ) {
      return undefined;
    }

    sourcePolicyMessages.push(projectedMessage);
  }

  const indexes = sourcePolicyMessages.map((message) => message.index);
  if (!areContiguous(indexes)) {
    return undefined;
  }

  const links = store.listReplacementMarkLinks(replacement.replacementID);
  const hiddenToolCallMessageIDs = links
    .map((link) => store.getMark(link.markID)?.toolCallMessageID)
    .filter((toolCallMessageID): toolCallMessageID is string => toolCallMessageID !== undefined);

  const referableIdentity = ensureReferableVisibleMessageIdentity(
    store,
    sourceMessages.map((message) => ({
      hostMessageID: message.hostMessageID,
      canonicalMessageID: message.canonicalMessageID,
    })),
  );

  return {
    replacement,
    sourceMessages,
    links,
    hiddenToolCallMessageIDs,
    startIndex: indexes[0] ?? 0,
    endIndex: indexes[indexes.length - 1] ?? 0,
    visibleMessageID: referableIdentity.visibleMessageID,
  };
}

function rangeOverlaps(startIndex: number, endIndex: number, occupiedIndexes: ReadonlySet<number>): boolean {
  for (let index = startIndex; index <= endIndex; index += 1) {
    if (occupiedIndexes.has(index)) {
      return true;
    }
  }

  return false;
}

function areContiguous(indexes: readonly number[]): boolean {
  if (indexes.length === 0) {
    return false;
  }

  for (let index = 1; index < indexes.length; index += 1) {
    if (indexes[index] !== indexes[index - 1] + 1) {
      return false;
    }
  }

  return true;
}

function renderCanonicalMessage(
  envelope: TransformEnvelope,
  visibleState: Exclude<ProjectionVisibleState, "referable">,
  visibleMessageID: string,
): TransformEnvelope {
  const info = structuredClone(envelope.info);
  const parts = structuredClone(envelope.parts);

  applyRenderedTextPrefix(parts, info, visibleState, visibleMessageID, readPrimaryMessageText(parts));

  return {
    info,
    parts,
  };
}

function renderAppliedReplacement(span: AppliedReplacementSpan, policy: ProjectionPolicy): TransformEnvelope {
  const baseMessage = policy.messages[span.startIndex];
  if (baseMessage === undefined) {
    throw new Error(`Missing base message at index ${span.startIndex} for replacement '${span.replacement.replacementID}'.`);
  }

  const info = structuredClone(baseMessage.envelope.info) as TransformMessage & Record<string, unknown>;
  // Present the synthetic replacement as assistant-authored so compacted summaries are not projected as user/tool turns.
  info.role = "assistant";
  delete info.parentID;

  return createSyntheticTextEnvelope({
    info,
    messageID: String(baseMessage.identity.hostMessageID),
    visibleState: "referable",
    visibleMessageID: span.visibleMessageID,
    text: readReplacementText(span.replacement, span.sourceMessages.length),
  });
}

function renderReminder(reminder: DerivedReminder, policy: ProjectionPolicy): TransformEnvelope {
  const anchor = policy.byHostMessageID.get(reminder.anchorHostMessageID);
  if (anchor === undefined) {
    throw new Error(`Missing reminder anchor '${reminder.anchorHostMessageID}'.`);
  }

  const info = structuredClone(anchor.envelope.info) as TransformMessage & Record<string, unknown>;
  info.id = `${anchor.identity.hostMessageID}:dcp-reminder:${reminder.severity}`;
  info.role = "assistant";
  delete info.parentID;

  return createSyntheticTextEnvelope({
    info,
    messageID: String(info.id),
    visibleState: "protected",
    visibleMessageID: reminder.visibleMessageID,
    text: reminder.text,
  });
}

function createSyntheticTextEnvelope(input: {
  readonly info: TransformMessage;
  readonly messageID: string;
  readonly visibleState: ProjectionVisibleState;
  readonly visibleMessageID: string;
  readonly text: string;
}): TransformEnvelope {
  const prefixText = renderPrefixedText(input.visibleState, input.visibleMessageID, input.text);

  return {
    info: input.info,
    parts: [
      {
        id: `${input.messageID}:dcp-text`,
        sessionID: input.info.sessionID,
        messageID: input.messageID,
        type: "text",
        text: prefixText,
      } as TransformPart,
    ],
  };
}

function applyRenderedTextPrefix(
  parts: TransformPart[],
  info: TransformMessage,
  visibleState: Exclude<ProjectionVisibleState, "referable">,
  visibleMessageID: string,
  currentPrimaryText: string | undefined,
): void {
  const renderedText = renderPrefixedText(visibleState, visibleMessageID, currentPrimaryText);
  const firstTextPart = parts.find(isTextPart);
  if (firstTextPart !== undefined) {
    firstTextPart.text = renderedText;
    return;
  }

  parts.unshift({
    id: `${info.id}:dcp-prefix`,
    sessionID: info.sessionID,
    messageID: info.id,
    type: "text",
    text: renderedText,
  } as TransformPart);
}

function isTextPart(part: TransformPart): part is TransformPart & { type: "text"; text: string } {
  return part.type === "text" && typeof (part as Record<string, unknown>).text === "string";
}

function readPrimaryMessageText(parts: readonly TransformPart[]): string | undefined {
  const firstTextPart = parts.find(isTextPart);
  return firstTextPart?.text;
}

function renderPrefixedText(
  visibleState: ProjectionVisibleState,
  visibleMessageID: string,
  text: string | undefined,
): string {
  const bareVisibleMessageID = normalizeVisibleMessageIDForRender(visibleMessageID);
  const prefix = `[${visibleState}_${bareVisibleMessageID}]`;
  return text && text.length > 0 ? `${prefix} ${text}` : prefix;
}

function normalizeVisibleMessageIDForRender(visibleMessageID: string): string {
  let normalized = visibleMessageID;

  while (true) {
    const statePrefixMatch = /^(protected|referable|compressible)_(.+)$/u.exec(normalized);
    if (statePrefixMatch === null) {
      break;
    }

    normalized = statePrefixMatch[2] ?? normalized;
  }

  return normalized.replace(LEGACY_ROLE_PREFIX_PATTERN, "");
}

function readReplacementText(replacement: ReplacementRecord, sourceCount: number): string {
  if (replacement.contentText !== undefined && replacement.contentText.length > 0) {
    return replacement.contentText;
  }

  if (replacement.contentJSON !== undefined) {
    return stableStringify(replacement.contentJSON);
  }

  return replacement.route === "delete"
    ? `Deleted ${sourceCount} earlier message(s).`
    : `Compacted ${sourceCount} earlier message(s).`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
