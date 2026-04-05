import type { MarkRecord, MarkStatus, SqliteSessionStateStore } from "../state/store.js";
import type { ProjectionPolicy } from "../projection/policy-engine.js";
import {
  createCoverageTreeRoot,
  insertIntoCoverageTree,
  type CoverageTreeNode,
  type CoverageTreeRoot,
} from "./coverage-tree.js";

export interface ReplayedMark {
  readonly mark: MarkRecord;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly historyIndex: number;
}

export interface InvalidReplayedMark {
  readonly mark: MarkRecord;
  readonly historyIndex: number;
  readonly errorText: string;
}

export interface MarkReplayRuntimeState {
  readonly markID: string;
  readonly toolCallMessageID: string;
  readonly sourceSnapshotID: string;
  readonly status: MarkStatus;
  readonly createdAtMs: number;
  readonly consumedAtMs?: number;
  readonly invalidatedAtMs?: number;
  readonly invalidationReason?: string;
}

export interface ReplayMarkHistoryResult {
  readonly root: CoverageTreeRoot<ReplayedMark>;
  readonly validNodes: readonly CoverageTreeNode<ReplayedMark>[];
  readonly invalidMarks: readonly InvalidReplayedMark[];
  readonly hiddenToolCallMessageIDs: readonly string[];
  readonly runtimeStates: readonly MarkReplayRuntimeState[];
}

export function replayMarkHistory(input: {
  readonly policy: ProjectionPolicy;
  readonly store: SqliteSessionStateStore;
}): ReplayMarkHistoryResult {
  const root = createCoverageTreeRoot<ReplayedMark>();
  const validNodes: CoverageTreeNode<ReplayedMark>[] = [];
  const invalidMarks: InvalidReplayedMark[] = [];

  const historyHostMessageIDs = readHistoryHostMessageIDs(input);

  historyHostMessageIDs.forEach((hostMessageID, historyIndex) => {
    const mark = input.store.getMarkByToolCallMessageID(hostMessageID);
    if (mark === undefined) {
      return;
    }

    const replayedMark = resolveReplayedMark({
      policy: input.policy,
      store: input.store,
      mark,
      historyIndex,
    });
    if (replayedMark === undefined) {
      return;
    }

    const inserted = insertIntoCoverageTree(root, replayedMark);
    if (!inserted.accepted || inserted.node === undefined) {
      invalidMarks.push({
        mark,
        historyIndex,
        errorText: buildIntersectingMarkErrorText(mark),
      });
      return;
    }

    validNodes.push(inserted.node);
  });

  return {
    root,
    validNodes,
    invalidMarks,
    hiddenToolCallMessageIDs: validNodes
      .map((node) => node.value.mark.toolCallMessageID)
      .sort(),
    runtimeStates: collectRuntimeStates({
      store: input.store,
      validNodes,
      invalidMarks,
    }),
  };
}

function readHistoryHostMessageIDs(input: {
  readonly policy: ProjectionPolicy;
  readonly store: SqliteSessionStateStore;
}): readonly string[] {
  const listHostMessages = (
    input.store as SqliteSessionStateStore & {
      listHostMessages?: () => Array<{
        hostMessageID: string;
        hostCreatedAtMs?: number;
        firstSeenAtMs: number;
      }>;
    }
  ).listHostMessages;

  if (typeof listHostMessages !== "function") {
    return input.policy.messages.map((message) => message.identity.hostMessageID);
  }

  return listHostMessages
    .call(input.store)
    .slice()
    .sort(
      (left, right) =>
        (left.hostCreatedAtMs ?? left.firstSeenAtMs) -
          (right.hostCreatedAtMs ?? right.firstSeenAtMs) ||
        left.firstSeenAtMs - right.firstSeenAtMs ||
        left.hostMessageID.localeCompare(right.hostMessageID),
    )
    .map((message) => message.hostMessageID);
}

export function flattenReplayTree(
  root: CoverageTreeRoot<ReplayedMark>,
): readonly CoverageTreeNode<ReplayedMark>[] {
  return root.children.flatMap((child) => [child, ...flattenReplayNode(child)]);
}

function flattenReplayNode(
  node: CoverageTreeNode<ReplayedMark>,
): readonly CoverageTreeNode<ReplayedMark>[] {
  return node.children.flatMap((child) => [child, ...flattenReplayNode(child)]);
}

function resolveReplayedMark(input: {
  readonly policy: ProjectionPolicy;
  readonly store: SqliteSessionStateStore;
  readonly mark: MarkRecord;
  readonly historyIndex: number;
}): ReplayedMark | undefined {
  const sourceMessages = input.store.listMarkSourceMessages(input.mark.markID);
  if (sourceMessages.length === 0) {
    return undefined;
  }

  const indexes = sourceMessages.map((sourceMessage) => {
    const policyMessage = input.policy.byHostMessageID.get(sourceMessage.hostMessageID);
    if (policyMessage === undefined) {
      return undefined;
    }

    if (
      policyMessage.identity.canonicalMessageID !== sourceMessage.canonicalMessageID ||
      policyMessage.identity.role !== sourceMessage.hostRole
    ) {
      return undefined;
    }

    return policyMessage.index;
  });

  if (indexes.some((index) => index === undefined)) {
    return undefined;
  }

  const resolvedIndexes = indexes as number[];
  if (!areContiguous(resolvedIndexes)) {
    return undefined;
  }

  return {
    mark: input.mark,
    startIndex: resolvedIndexes[0] ?? 0,
    endIndex: resolvedIndexes[resolvedIndexes.length - 1] ?? 0,
    historyIndex: input.historyIndex,
  };
}

function collectRuntimeStates(input: {
  readonly store: SqliteSessionStateStore;
  readonly validNodes: readonly CoverageTreeNode<ReplayedMark>[];
  readonly invalidMarks: readonly InvalidReplayedMark[];
}): readonly MarkReplayRuntimeState[] {
  const states: MarkReplayRuntimeState[] = [];

  for (const node of input.validNodes) {
    const group = input.store.getReplacementResultGroup(node.value.mark.markID);
    const mark = node.value.mark;
    const hasCompleteGroup = group?.completeness === "complete";
    states.push({
      markID: mark.markID,
      toolCallMessageID: mark.toolCallMessageID,
      sourceSnapshotID: mark.sourceSnapshotID,
      status: hasCompleteGroup ? "consumed" : "active",
      createdAtMs: mark.createdAtMs,
      consumedAtMs: hasCompleteGroup ? group?.committedAtMs : undefined,
      invalidatedAtMs: undefined,
      invalidationReason: undefined,
    });
  }

  for (const invalidMark of input.invalidMarks) {
    states.push({
      markID: invalidMark.mark.markID,
      toolCallMessageID: invalidMark.mark.toolCallMessageID,
      sourceSnapshotID: invalidMark.mark.sourceSnapshotID,
      status: "invalid",
      createdAtMs: invalidMark.mark.createdAtMs,
      invalidatedAtMs:
        invalidMark.mark.invalidatedAtMs ?? invalidMark.mark.createdAtMs,
      invalidationReason: invalidMark.errorText,
    });
  }

  return states;
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

function buildIntersectingMarkErrorText(mark: MarkRecord): string {
  return `compression_mark replay error: mark '${mark.markID}' overlaps an earlier valid mark without containment, so this call stays visible as an error and is excluded from coverage-tree rendering.`;
}
