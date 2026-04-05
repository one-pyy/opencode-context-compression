import type {
  ReplacementResultGroupItemRecord,
  ReplacementRecord,
  SourceSnapshotMessageRecord,
  SqliteSessionStateStore,
} from "../state/store.js";
import type { ReminderRuntimeConfig } from "../config/runtime-config.js";
import {
  ensureReferableVisibleMessageIdentity,
} from "../identity/visible-sequence.js";
import { writePromptVisibleIdentityMetadata } from "../identity/canonical-identity.js";
import type {
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../seams/noop-observation.js";
import {
  replayMarkHistory,
  type ReplayedMark,
} from "../replay/mark-replay.js";
import type { CoverageTreeNode, CoverageTreeRoot } from "../replay/coverage-tree.js";
import {
  buildProjectionPolicy,
  type ProjectionPolicy,
  type ProjectionVisibleState,
} from "./policy-engine.js";
import { deriveReminder, type DerivedReminder } from "./reminder-service.js";

export interface ProjectionBuilderOptions {
  readonly messages: readonly TransformEnvelope[];
  readonly store: SqliteSessionStateStore;
  readonly reminder?: ReminderRuntimeConfig;
  readonly smallUserMessageThreshold?: number;
  readonly reminderModelName?: string;
  readonly deleteModeAllowed?: boolean;
}

export interface ProjectionBuildResult {
  readonly projectedMessages: readonly TransformEnvelope[];
  readonly policy: ProjectionPolicy;
  readonly reminder?: DerivedReminder;
  readonly appliedReplacementIDs: readonly string[];
  readonly hiddenToolCallMessageIDs: readonly string[];
}

interface AppliedReplacementSpan {
  readonly replacement?: ReplacementRecord;
  readonly resultGroupItem: ReplacementResultGroupItemRecord;
  readonly executionMode: "compact" | "delete";
  readonly sourceMessages: readonly SourceSnapshotMessageRecord[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly visibleMessageID: string;
}

export function buildProjectedMessages(
  options: ProjectionBuilderOptions,
): ProjectionBuildResult {
  const policy = buildProjectionPolicy({
    messages: options.messages,
    store: options.store,
    smallUserMessageThreshold: options.smallUserMessageThreshold,
  });
  const replay = replayMarkHistory({
    policy,
    store: options.store,
  });

  syncReplayRuntimeState(options.store, replay);

  const reminder = options.reminder
      ? deriveReminder({
          policy,
          cadence: options.reminder,
          texts: selectReminderTexts({
            deleteModeAllowed: options.deleteModeAllowed,
            reminder: options.reminder,
          }),
          modelName: options.reminderModelName,
        })
    : undefined;
  const appliedSpans = collectAppliedReplacementSpans({
    policy,
    store: options.store,
    replayRoot: replay.root,
  });
  const spanByStartIndex = new Map(
    appliedSpans.map((span) => [span.startIndex, span]),
  );
  const hiddenToolCallMessageIDs = new Set(replay.hiddenToolCallMessageIDs);
  const invalidMarksByToolCallMessageID = new Map(
    replay.invalidMarks.map((invalidMark) => [
      invalidMark.mark.toolCallMessageID,
      invalidMark,
    ]),
  );
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

      index = span.endIndex + 1;
      continue;
    }

    const invalidMark = invalidMarksByToolCallMessageID.get(
      message.identity.hostMessageID,
    );
    if (invalidMark !== undefined) {
      projectedMessages.push(
        renderRewrittenCanonicalMessage(
          message.envelope,
          message.visibleState,
          message.visible.visibleMessageID,
          invalidMark.errorText,
        ),
      );
    } else {
      projectedMessages.push(
        renderCanonicalMessage(
          message.envelope,
          message.visibleState,
          message.visible.visibleMessageID,
        ),
      );
    }

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
    appliedReplacementIDs: appliedSpans
      .map((span) => span.replacement?.replacementID ?? span.resultGroupItem.replacementID)
      .filter((replacementID): replacementID is string => replacementID !== undefined),
    hiddenToolCallMessageIDs: [...hiddenToolCallMessageIDs].sort(),
  };
}

function syncReplayRuntimeState(
  store: SqliteSessionStateStore,
  replay: ReturnType<typeof replayMarkHistory>,
): void {
  for (const runtimeState of replay.runtimeStates) {
    store.upsertMarkRuntimeState?.({
      markID: runtimeState.markID,
      toolCallMessageID: runtimeState.toolCallMessageID,
      sourceSnapshotID: runtimeState.sourceSnapshotID,
      status: runtimeState.status,
      createdAtMs: runtimeState.createdAtMs,
      consumedAtMs: runtimeState.consumedAtMs,
      invalidatedAtMs: runtimeState.invalidatedAtMs,
      invalidationReason: runtimeState.invalidationReason,
    });
  }
}

function selectReminderTexts(input: {
  readonly deleteModeAllowed?: boolean;
  readonly reminder: ReminderRuntimeConfig;
}): { soft: string; hard: string } {
  const promptSet = input.deleteModeAllowed
    ? input.reminder.prompts.deleteAllowed
    : input.reminder.prompts.compactOnly;

  return {
    soft: promptSet.soft.text,
    hard: promptSet.hard.text,
  };
}

function collectAppliedReplacementSpans(input: {
  readonly policy: ProjectionPolicy;
  readonly store: SqliteSessionStateStore;
  readonly replayRoot: CoverageTreeRoot<ReplayedMark>;
}): AppliedReplacementSpan[] {
  return input.replayRoot.children
    .flatMap((node) => collectRenderableSpansFromNode(node, input.policy, input.store))
    .sort(
      (left, right) =>
        left.startIndex - right.startIndex ||
        readCommittedAtMs(left) - readCommittedAtMs(right) ||
        readStableSpanID(left).localeCompare(readStableSpanID(right)),
    );
}

function collectRenderableSpansFromNode(
  node: CoverageTreeNode<ReplayedMark>,
  policy: ProjectionPolicy,
  store: SqliteSessionStateStore,
): AppliedReplacementSpan[] {
  const appliedSpan = createAppliedReplacementSpan(node.value.mark.markID, policy, store);
  if (appliedSpan !== undefined) {
    return [appliedSpan];
  }

  return node.children.flatMap((child) =>
    collectRenderableSpansFromNode(child, policy, store),
  );
}

function createAppliedReplacementSpan(
  markID: string,
  policy: ProjectionPolicy,
  store: SqliteSessionStateStore,
): AppliedReplacementSpan | undefined {
  const resultGroup = store.getReplacementResultGroup?.(markID);
  if (resultGroup?.completeness !== "complete") {
    return undefined;
  }

  const resultGroupItem = store.listReplacementResultGroupItems?.(markID)?.[0];
  if (resultGroupItem === undefined) {
    return undefined;
  }

  const replacement = resolveAppliedReplacementRecord(store, markID, resultGroupItem);
  if (
    replacement !== undefined &&
    (replacement.status !== "committed" || replacement.invalidatedAtMs !== undefined)
  ) {
    return undefined;
  }

  const sourceMessages = store.listMarkSourceMessages(markID);
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

  const referableIdentity = ensureReferableVisibleMessageIdentity(
    store,
    sourceMessages.map((message) => ({
      hostMessageID: message.hostMessageID,
      canonicalMessageID: message.canonicalMessageID,
    })),
  );

  return {
    replacement,
    resultGroupItem,
    executionMode: resultGroup.executionMode,
    sourceMessages,
    startIndex: indexes[0] ?? 0,
    endIndex: indexes[indexes.length - 1] ?? 0,
    visibleMessageID: referableIdentity.visibleMessageID,
  };
}

function resolveAppliedReplacementRecord(
  store: SqliteSessionStateStore,
  markID: string,
  resultGroupItem: ReplacementResultGroupItemRecord,
): ReplacementRecord | undefined {
  if (resultGroupItem.replacementID !== undefined) {
    return store.getReplacement(resultGroupItem.replacementID);
  }

  return store.findLatestCommittedReplacementForMark(markID);
}

function readCommittedAtMs(span: AppliedReplacementSpan): number {
  return span.replacement?.committedAtMs ?? 0;
}

function readStableSpanID(span: AppliedReplacementSpan): string {
  return (
    span.replacement?.replacementID ??
    span.resultGroupItem.replacementID ??
    `${span.visibleMessageID}:${span.startIndex}:${span.endIndex}`
  );
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
  writePromptVisibleIdentityMetadata(info, {
    visibleState,
    visibleMessageID,
  });

  return {
    info,
    parts,
  };
}

function renderRewrittenCanonicalMessage(
  envelope: TransformEnvelope,
  visibleState: Exclude<ProjectionVisibleState, "referable">,
  visibleMessageID: string,
  rewrittenText: string,
): TransformEnvelope {
  const info = structuredClone(envelope.info);
  const parts = structuredClone(envelope.parts);
  writePrimaryMessageText(parts, info, rewrittenText);
  writePromptVisibleIdentityMetadata(info, {
    visibleState,
    visibleMessageID,
  });

  return {
    info,
    parts,
  };
}

function renderAppliedReplacement(
  span: AppliedReplacementSpan,
  policy: ProjectionPolicy,
): TransformEnvelope {
  const baseMessage = policy.messages[span.startIndex];
  if (baseMessage === undefined) {
    throw new Error(
      `Missing base message at index ${span.startIndex} for replacement '${readStableSpanID(span)}'.`,
    );
  }

  const info = structuredClone(baseMessage.envelope.info) as TransformMessage &
    Record<string, unknown>;
  info.role = "assistant";
  delete info.parentID;

  return createSyntheticTextEnvelope({
    info,
    messageID: String(baseMessage.identity.hostMessageID),
    visibleState: "referable",
    visibleMessageID: span.visibleMessageID,
    text: readReplacementText(span),
  });
}

function renderReminder(
  reminder: DerivedReminder,
  policy: ProjectionPolicy,
): TransformEnvelope {
  const anchor = policy.byHostMessageID.get(reminder.anchorHostMessageID);
  if (anchor === undefined) {
    throw new Error(
      `Missing reminder anchor '${reminder.anchorHostMessageID}'.`,
    );
  }

  const info = structuredClone(anchor.envelope.info) as TransformMessage &
    Record<string, unknown>;
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
  writePromptVisibleIdentityMetadata(input.info, {
    visibleState: input.visibleState,
    visibleMessageID: input.visibleMessageID,
  });

  return {
    info: input.info,
    parts: [
      {
        id: `${input.messageID}:dcp-text`,
        sessionID: input.info.sessionID,
        messageID: input.messageID,
        type: "text",
        text: input.text,
      } as TransformPart,
    ],
  };
}

function writePrimaryMessageText(
  parts: TransformPart[],
  info: TransformMessage,
  text: string,
): void {
  const firstTextPart = parts.find(isTextPart);
  if (firstTextPart !== undefined) {
    firstTextPart.text = text;
    return;
  }

  const firstInputTextPart = parts.find(isInputTextPart);
  if (firstInputTextPart !== undefined) {
    (firstInputTextPart as TransformPart & { text: string }).text = text;
    return;
  }

  parts.unshift({
    id: `${info.id}:dcp-rewrite`,
    sessionID: info.sessionID,
    messageID: info.id,
    type: "text",
    text,
  } as TransformPart);
}

function isTextPart(
  part: TransformPart,
): part is TransformPart & { type: "text"; text: string } {
  return (
    part.type === "text" &&
    typeof (part as Record<string, unknown>).text === "string"
  );
}

function isInputTextPart(
  part: TransformPart,
): part is TransformPart & { type: "input_text"; text: string } {
  const type = (part as Record<string, unknown>).type;
  return (
    type === "input_text" &&
      typeof (part as Record<string, unknown>).text === "string"
  );
}

function readReplacementText(span: AppliedReplacementSpan): string {
  if (
    span.resultGroupItem.contentText !== undefined &&
    span.resultGroupItem.contentText.length > 0
  ) {
    return span.resultGroupItem.contentText;
  }

  if (
    span.replacement?.contentText !== undefined &&
    span.replacement.contentText.length > 0
  ) {
    return span.replacement.contentText;
  }

  if (span.resultGroupItem.contentJSON !== undefined) {
    return stableStringify(span.resultGroupItem.contentJSON);
  }

  if (span.replacement?.contentJSON !== undefined) {
    return stableStringify(span.replacement.contentJSON);
  }

  return span.executionMode === "delete"
    ? `Deleted ${span.sourceMessages.length} earlier message(s).`
    : `Compacted ${span.sourceMessages.length} earlier message(s).`;
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
