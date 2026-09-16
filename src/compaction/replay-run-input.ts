import type { ProjectionState, MarkTreeNode } from "../projection/types.js";
import { renderModelVisiblePartsText } from "../model-visible-transcript.js";
import type { CompleteResultGroup, ResultGroupFragment } from "../state/result-group-repository.js";
import { CONTEXT_COMPRESSION_NOTICE_TOOL_NAME } from "../tools/context-compression-notice.js";
import type {
  CompactionBuildTranscriptEntry,
  RunCompactionInput,
} from "./types.js";

export interface BuildCompactionRunInputForMarkOptions {
  readonly sessionId: string;
  readonly state: ProjectionState;
  readonly markId: string;
  readonly model: string;
  readonly promptText: string;
  readonly deletePromptText?: string;
  readonly appliedResultGroupIds?: ReadonlySet<string>;
  readonly timeoutMs: number;
  readonly firstTokenTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly compactionModels?: readonly string[];
  readonly createdAt?: string;
  readonly committedAt?: string;
}

export function buildCompactionRunInputForMark(
  options: BuildCompactionRunInputForMarkOptions,
): RunCompactionInput {
  const markNode = findMarkTreeNodeById(options.state.markTree.marks, options.markId);
  if (!markNode) {
    throw new Error(
      `Cannot build compaction input because mark '${options.markId}' is not present in the replayed coverage tree.`,
    );
  }

  const { transcript, preservedFragments } = buildTranscriptForMarkNode(
    options.state, markNode, options.appliedResultGroupIds,
  );
  const promptText = markNode.mode === "delete" ? options.deletePromptText : options.promptText;
  if (!promptText?.trim()) {
    throw new Error(`Missing ${markNode.mode} prompt for mark '${markNode.markId}'.`);
  }
  return {
    build: {
      sessionId: options.sessionId,
      markId: options.markId,
      model: options.model,
      executionMode: markNode.mode,
      promptText,
      timeoutMs: options.timeoutMs,
      ...(options.firstTokenTimeoutMs !== undefined
        ? { firstTokenTimeoutMs: options.firstTokenTimeoutMs }
        : {}),
      ...(options.streamIdleTimeoutMs !== undefined
        ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
        : {}),
      signal: options.signal,
      transcript,
      hint: markNode.hint,
    },
    ...(options.compactionModels
      ? { compactionModels: options.compactionModels }
      : {}),
    resultGroup: {
      sourceStartSeq: markNode.startSequence,
      sourceEndSeq: markNode.endSequence,
      ...(preservedFragments.length > 0 ? { preservedFragments } : {}),
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options.committedAt ? { committedAt: options.committedAt } : {}),
    },
  } satisfies RunCompactionInput;
}

function buildTranscriptForMarkNode(
  state: ProjectionState,
  markNode: MarkTreeNode,
  appliedResultGroupIds?: ReadonlySet<string>,
): {
  transcript: readonly CompactionBuildTranscriptEntry[];
  preservedFragments: readonly ResultGroupFragment[];
} {
  const transcript: CompactionBuildTranscriptEntry[] = [];
  const preservedFragments: ResultGroupFragment[] = [];
  let opaqueSlotCounter = 1;
  const groups = new Map(state.resultGroups.map((group) => [group.markId, group]));
  const effectiveGroups: CompleteResultGroup[] = [];
  const suppressedMarkMessages = new Set<string>();

  function collect(nodes: readonly MarkTreeNode[]): void {
    for (const node of nodes) {
      const group = groups.get(node.markId);
      const applied = appliedResultGroupIds === undefined
        ? group?.applied
        : appliedResultGroupIds.has(node.markId);
      if (group && applied) {
        effectiveGroups.push(group);
        suppressedMarkMessages.add(node.sourceMessageId);
      } else {
        collect(node.children);
      }
    }
  }
  collect(state.markTree.marks);

  const fragments = effectiveGroups.flatMap((group) => group.fragments.map((fragment) => ({ group, fragment })))
    .filter(({ fragment }) => fragment.sourceStartSeq <= markNode.endSequence && fragment.sourceEndSeq >= markNode.startSequence)
    .sort((a, b) => a.fragment.sourceStartSeq - b.fragment.sourceStartSeq);
  for (const { group, fragment } of fragments) {
    if (fragment.sourceStartSeq < markNode.startSequence || fragment.sourceEndSeq > markNode.endSequence) {
      throw new Error("Selected range must include each applied summary fragment in full; adjust the range before retrying.");
    }
    if (group.mode === "delete") {
      throw new Error("Selected range contains an applied delete result; select a range outside that result.");
    }
  }
  const fragmentsByStart = new Map(fragments.map((entry) => [entry.fragment.sourceStartSeq, entry]));
  const messagesBySequence = new Map(state.history.messages.map((message) => [message.sequence, message]));
  const policiesById = new Map(state.messagePolicies.map((policy) => [policy.canonicalId, policy]));
  // Check original roles even when an applied result hides their text.
  if (state.history.messages.some((message) => message.role === "system" &&
    message.sequence >= markNode.startSequence && message.sequence <= markNode.endSequence)) {
    throw new Error(`Compaction input for mark '${markNode.markId}' cannot include protected system message.`);
  }

  for (
    let sequence = markNode.startSequence;
    sequence <= markNode.endSequence;
    sequence += 1
  ) {
    const replacement = fragmentsByStart.get(sequence);
    if (replacement) {
      const { group, fragment } = replacement;
      const preserve = markNode.mode === "compact";
      transcript.push({
        role: "assistant",
        hostMessageId: `summary:${group.markId}:${fragment.fragmentIndex}`,
        sourceStartSeq: fragment.sourceStartSeq,
        sourceEndSeq: fragment.sourceEndSeq,
        contentText: fragment.replacementText,
        ...(preserve ? { opaquePlaceholder: { slot: `S${opaqueSlotCounter++}` } } : {}),
      });
      if (preserve) preservedFragments.push(fragment);
      sequence = fragment.sourceEndSeq;
      continue;
    }
    const message = messagesBySequence.get(sequence);
    if (!message || message.role === "system") {
      continue;
    }

    if (suppressedMarkMessages.has(message.canonicalId)) continue;

    const parts = markNode.mode === "delete"
      ? message.parts.filter((part) => !(part.type === "tool" && part.tool === CONTEXT_COMPRESSION_NOTICE_TOOL_NAME))
      : message.parts;
    const contentText = renderModelVisiblePartsText(parts, {
      stripLeadingVisibleIdPrefix: true,
    });
    
    if (contentText.length === 0) {
      continue;
    }

    const policy = policiesById.get(message.canonicalId);

    const isProtected = markNode.mode === "compact" && policy?.visibleKind === "protected";
    const opaquePlaceholder = isProtected
      ? { slot: `S${opaqueSlotCounter++}` }
      : undefined;

    transcript.push({
      role: message.role,
      hostMessageId: message.canonicalId,
      sourceStartSeq: message.sequence,
      sourceEndSeq: message.sequence,
      contentText,
      ...(opaquePlaceholder ? { opaquePlaceholder } : {}),
    });
  }

  if (transcript.length === 0) {
    throw new Error(
      `Compaction input for mark '${markNode.markId}' resolved to an empty transcript range.`,
    );
  }

  return { transcript: Object.freeze(transcript), preservedFragments: Object.freeze(preservedFragments) };
}

function findMarkTreeNodeById(
  marks: readonly MarkTreeNode[],
  markId: string,
): MarkTreeNode | undefined {
  for (const mark of marks) {
    if (mark.markId === markId) {
      return mark;
    }

    const nested = findMarkTreeNodeById(mark.children, markId);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}
