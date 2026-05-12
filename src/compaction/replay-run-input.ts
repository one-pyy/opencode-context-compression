import type { ProjectionState, MarkTreeNode } from "../projection/types.js";
import { renderModelVisiblePartsText } from "../model-visible-transcript.js";
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
  readonly timeoutMs: number;
  readonly firstTokenTimeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly compactionModels?: readonly string[];
  readonly maxAttemptsPerModel?: number;
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

  const transcript = buildTranscriptForMarkNode(options.state, markNode);
  return {
    build: {
      sessionId: options.sessionId,
      markId: options.markId,
      model: options.model,
      executionMode: markNode.mode,
      promptText: options.promptText,
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
    ...(options.maxAttemptsPerModel !== undefined
      ? { maxAttemptsPerModel: options.maxAttemptsPerModel }
      : {}),
    resultGroup: {
      sourceStartSeq: markNode.startSequence,
      sourceEndSeq: markNode.endSequence,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options.committedAt ? { committedAt: options.committedAt } : {}),
    },
  } satisfies RunCompactionInput;
}

function buildTranscriptForMarkNode(
  state: ProjectionState,
  markNode: MarkTreeNode,
): readonly CompactionBuildTranscriptEntry[] {
  const transcript: CompactionBuildTranscriptEntry[] = [];
  let opaqueSlotCounter = 1;

  for (
    let sequence = markNode.startSequence;
    sequence <= markNode.endSequence;
    sequence += 1
  ) {
    const message = state.history.messages.find(
      (candidate) => candidate.sequence === sequence,
    );
    if (!message) {
      continue;
    }

    if (message.role === "system") {
      throw new Error(
        `Compaction input for mark '${markNode.markId}' cannot include protected system message '${message.canonicalId}'.`,
      );
    }

    const contentText = renderModelVisiblePartsText(message.parts, {
      stripLeadingVisibleIdPrefix: true,
    });
    
    if (contentText.length === 0) {
      continue;
    }

    const policy = state.messagePolicies.find(
      (p) => p.canonicalId === message.canonicalId,
    );

    const isProtected = policy?.visibleKind === "protected";
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

  return Object.freeze(transcript);
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
