import { InvalidCompactionOutputError } from "../errors.js";
import type { CompactionRequest, RunCompactionInput, ValidatedCompactionOutput } from "../types.js";
import type { CompleteResultGroupInput } from "../../state/result-group-repository.js";

type PersistedFragment = CompleteResultGroupInput["fragments"][number];

export interface BuildCompactionResultGroupInput {
  readonly request: CompactionRequest;
  readonly validatedOutput: ValidatedCompactionOutput;
  readonly runInput: RunCompactionInput;
  readonly now: () => string;
}

export function buildCompactionResultGroup(
  input: BuildCompactionResultGroupInput,
): CompleteResultGroupInput {
  const sourceStartSeq = resolveSourceStartSeq(input);
  const sourceEndSeq = resolveSourceEndSeq(input);
  const createdAt = input.runInput.resultGroup?.createdAt ?? input.now();
  const committedAt = input.runInput.resultGroup?.committedAt ?? createdAt;
  const fragments = buildFragments(input, sourceStartSeq, sourceEndSeq);

  return {
    markId: input.request.markID,
    mode: input.request.executionMode,
    sourceStartSeq,
    sourceEndSeq,
    modelName: input.request.model,
    executionMode: input.request.executionMode,
    createdAt,
    committedAt,
    fragments,
  } satisfies CompleteResultGroupInput;
}

function buildFragments(
  input: BuildCompactionResultGroupInput,
  sourceStartSeq: number,
  sourceEndSeq: number,
): CompleteResultGroupInput["fragments"] {
  const placeholderEntries = input.request.transcript.filter(
    (entry) => entry.opaquePlaceholderSlot !== undefined,
  );

  if (input.request.executionMode === "delete" || placeholderEntries.length === 0) {
    return [
      {
        sourceStartSeq,
        sourceEndSeq,
        replacementText: input.validatedOutput.contentText,
      },
    ];
  }

  const fragments: PersistedFragment[] = [];
  let transcriptCursor = 0;
  let contentCursor = 0;

  placeholderEntries.forEach((placeholderEntry) => {
    const placeholderTranscriptIndex = input.request.transcript.indexOf(placeholderEntry);
    const placeholderContentIndex = input.validatedOutput.contentText.indexOf(
      placeholderEntry.contentText,
      contentCursor,
    );

    if (placeholderContentIndex < 0) {
      throw new InvalidCompactionOutputError({
        markId: input.request.markID,
        model: input.request.model,
        executionMode: input.request.executionMode,
        detail: `compact output lost opaque placeholder '${placeholderEntry.opaquePlaceholderSlot}'.`,
      });
    }

    const replacementText = input.validatedOutput.contentText
      .slice(contentCursor, placeholderContentIndex)
      .trim();
    appendFragmentForWindow({
      fragments,
      transcriptWindow: input.request.transcript.slice(
        transcriptCursor,
        placeholderTranscriptIndex,
      ),
      replacementText,
      request: input.request,
    });

    transcriptCursor = placeholderTranscriptIndex + 1;
    contentCursor = placeholderContentIndex + placeholderEntry.contentText.length;
  });

  appendFragmentForWindow({
    fragments,
    transcriptWindow: input.request.transcript.slice(transcriptCursor),
    replacementText: input.validatedOutput.contentText.slice(contentCursor).trim(),
    request: input.request,
  });

  if (fragments.length === 0) {
    throw new InvalidCompactionOutputError({
      markId: input.request.markID,
      model: input.request.model,
      executionMode: input.request.executionMode,
      detail:
        "compact output preserved opaque placeholders but produced no persistable replacement text.",
    });
  }

  return fragments;
}

function appendFragmentForWindow(input: {
  readonly fragments: PersistedFragment[];
  readonly transcriptWindow: ReadonlyArray<CompactionRequest["transcript"][number]>;
  readonly replacementText: string;
  readonly request: CompactionRequest;
}): void {
  if (input.replacementText.length === 0) {
    return;
  }

  const sourceEntries = input.transcriptWindow.filter(
    (entry) => entry.opaquePlaceholderSlot === undefined,
  );

  if (sourceEntries.length === 0) {
    throw new InvalidCompactionOutputError({
      markId: input.request.markID,
      model: input.request.model,
      executionMode: input.request.executionMode,
      detail:
        "compact output introduced replacement text for an opaque-only window, which cannot be mapped to a source range.",
    });
  }

  input.fragments.push({
    sourceStartSeq: sourceEntries[0].sourceStartSeq,
    sourceEndSeq: sourceEntries.at(-1)?.sourceEndSeq ?? sourceEntries[0].sourceEndSeq,
    replacementText: input.replacementText,
  });
}

function resolveSourceStartSeq(input: BuildCompactionResultGroupInput): number {
  return (
    input.runInput.resultGroup?.sourceStartSeq ??
    input.request.transcript[0]?.sourceStartSeq ??
    1
  );
}

function resolveSourceEndSeq(input: BuildCompactionResultGroupInput): number {
  return (
    input.runInput.resultGroup?.sourceEndSeq ??
    input.request.transcript.at(-1)?.sourceEndSeq ??
    resolveSourceStartSeq(input)
  );
}
