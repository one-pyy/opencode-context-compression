import type { VisibleKind } from "../identity/visible-id.js";
import {
  buildReferableMarkerIds,
  parseVisibleId,
} from "../identity/visible-sequence.js";
import type { CompleteResultGroup } from "../state/result-group-repository.js";
import {
  createCompressionInspectFailure,
  serializeCompressionInspectResult,
  type CompressionInspectAtom,
  type CompressionInspectEntry,
  type CompressionInspectMessageTokenInfo,
  type CompressionInspectSection,
} from "../tools/compression-inspect.js";
import type {
  MessageProjectionPolicy,
  ProjectedPromptMessage,
  ProjectionState,
  ToolResultOverride,
} from "./types.js";

export interface CompressionInspectVisibleEntry {
  readonly id: string;
  readonly visibleKind: VisibleKind;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly tokens: number;
}

export function buildCompressionInspectOverrides(
  state: ProjectionState,
  projectedMessages: readonly ProjectedPromptMessage[],
): readonly ToolResultOverride[] {
  return Object.freeze(
    (state.history.compressionInspectToolCalls ?? []).flatMap((call) => {
      if (
        call.outcome !== "accepted" ||
        call.endVisibleMessageId === undefined
      ) {
        return [];
      }

      let output: string;
      try {
        if (call.mode === "delete") {
          const entries = buildCompressionInspectDeleteEntries({
            messages: projectedMessages,
            policies: state.messagePolicies,
            resultGroups: state.resultGroups,
            to: call.endVisibleMessageId,
          });
          output = serializeCompressionInspectResult({
            ok: true,
            mode: "delete",
            entries,
            totalTokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
          });
        } else {
          const entries = inspectVisibleEntriesInRange({
            projectedMessages,
            policies: state.messagePolicies,
            from: call.startVisibleMessageId,
            to: call.endVisibleMessageId,
          });
          if (call.mergeAdjacent !== false) {
            const sections = groupCompressionInspectEntries(entries);
            output = serializeCompressionInspectResult({
              ok: true,
              sections,
              totalTokens: sections.reduce(
                (sum, section) => sum + section.totalTokens,
                0,
              ),
            });
          } else {
            const messages = Object.freeze(
              entries
                .filter((entry) => entry.visibleKind === "compressible")
                .map((entry) =>
                  Object.freeze({
                    id: toVisibleIdLookupKey(entry.id),
                    tokens: entry.tokens,
                  } satisfies CompressionInspectMessageTokenInfo),
                ),
            );
            output = serializeCompressionInspectResult({ ok: true, messages });
          }
        }
      } catch (error) {
        output = serializeCompressionInspectResult(
          createCompressionInspectFailure(
            "INVALID_RANGE",
            error instanceof Error
              ? error.message
              : "compression_inspect could not resolve the requested range.",
            {
              to: call.endVisibleMessageId,
            },
          ),
        );
      }

      return [
        Object.freeze({
          sourceMessageId: call.sourceMessageId,
          toolName: "compression_inspect",
          output,
        } satisfies ToolResultOverride),
      ];
    }),
  );
}

export function buildCompressionInspectListing(input: {
  readonly messages: readonly ProjectedPromptMessage[];
  readonly policies: readonly MessageProjectionPolicy[];
  readonly to: string;
  readonly mode?: "compact" | "delete";
  readonly resultGroups?: readonly CompleteResultGroup[];
}): string | undefined {
  try {
    if (input.mode === "delete") {
      const entries = buildCompressionInspectDeleteEntries({
        messages: input.messages,
        policies: input.policies,
        resultGroups: input.resultGroups ?? [],
        to: input.to,
      });
      return serializeCompressionInspectResult({
        ok: true,
        mode: "delete",
        entries,
        totalTokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
      });
    }
    const entries = inspectVisibleEntriesInRange({
      projectedMessages: input.messages,
      policies: input.policies,
      to: input.to,
    });
    const sections = groupCompressionInspectEntries(entries);
    return serializeCompressionInspectResult({
      ok: true,
      sections,
      totalTokens: sections.reduce((sum, section) => sum + section.totalTokens, 0),
    });
  } catch {
    // A stale anchor must never block projection; the reminder just ships without a listing.
    return undefined;
  }
}

export function buildCompressionInspectDeleteEntries(input: {
  readonly messages: readonly ProjectedPromptMessage[];
  readonly policies: readonly MessageProjectionPolicy[];
  readonly resultGroups: readonly CompleteResultGroup[];
  readonly to: string;
}): readonly CompressionInspectEntry[] {
  const entries = collectProjectedEntries(input.messages, input.policies, true);
  const range = parseInclusiveVisibleRange({
    policies: input.policies,
    entries,
    // Delete planning must cover the whole selectable span, including compact
    // fragments and protected user messages that precede the first compressible one.
    from: entries.find((entry) => entry.role !== "system")?.id,
    to: input.to,
  });
  const fragments = buildCompressionInspectFragmentEntries({
    resultGroups: input.resultGroups,
  });
  const result: CompressionInspectEntry[] = [];
  let currentCompressible:
    | { from: string; to: string; tokens: number }
    | undefined;

  const flushCompressible = () => {
    if (currentCompressible === undefined) return;
    result.push(
      Object.freeze({
        kind: "compressible",
        from: currentCompressible.from,
        to: currentCompressible.to,
        tokens: currentCompressible.tokens,
      } satisfies CompressionInspectEntry),
    );
    currentCompressible = undefined;
  };

  for (const entry of entries) {
    const visibleSeq = parseVisibleId(entry.id).visibleSeq;
    if (visibleSeq < range.startVisibleSeq || visibleSeq > range.endVisibleSeq) {
      continue;
    }

    if (entry.visibleKind === "referable") {
      flushCompressible();
      const fragment = fragments.get(toVisibleIdLookupKey(entry.id));
      if (fragment !== undefined) {
        result.push(
          Object.freeze({
            kind: "fragment",
            from: fragment.from,
            to: fragment.to,
            tokens: entry.tokens,
          } satisfies CompressionInspectEntry),
        );
      }
      continue;
    }

    if (entry.visibleKind === "protected") {
      flushCompressible();
      if (entry.role === "user") {
        const id = toVisibleIdLookupKey(entry.id);
        result.push(
          Object.freeze({
            kind: "user",
            from: id,
            to: id,
            tokens: entry.tokens,
          } satisfies CompressionInspectEntry),
        );
      }
      continue;
    }

    const atomId = toVisibleIdLookupKey(entry.id);
    currentCompressible =
      currentCompressible === undefined
        ? { from: atomId, to: atomId, tokens: entry.tokens }
        : {
            ...currentCompressible,
            to: atomId,
            tokens: currentCompressible.tokens + entry.tokens,
          };
  }

  flushCompressible();
  return Object.freeze(result);
}

function buildCompressionInspectFragmentEntries(input: {
  readonly resultGroups: readonly CompleteResultGroup[];
}): ReadonlyMap<
  string,
  { readonly from: string; readonly to: string }
> {
  const fragments = new Map<
    string,
    { readonly from: string; readonly to: string }
  >();

  input.resultGroups.forEach((group) => {
    if (group.mode !== "compact") {
      return;
    }

    group.fragments.forEach((fragment) => {
      const markers = buildReferableMarkerIds({
        markId: group.markId,
        fragmentIndex: fragment.fragmentIndex,
        sourceStartSeq: fragment.sourceStartSeq,
        sourceEndSeq: fragment.sourceEndSeq,
      });
      fragments.set(toVisibleIdLookupKey(markers.startId), {
        from: markers.startId,
        to: markers.endId,
      });
    });
  });

  return fragments;
}

export function groupCompressionInspectEntries(
  entries: readonly CompressionInspectVisibleEntry[],
): readonly CompressionInspectSection[] {
  const sections: CompressionInspectSection[] = [];
  let atoms: CompressionInspectAtom[] = [];
  let currentAtom:
    | {
        from: string;
        to: string;
        tokens: number;
      }
    | undefined;

  const flushAtom = () => {
    if (currentAtom === undefined) return;
    atoms.push(Object.freeze(currentAtom));
    currentAtom = undefined;
  };

  const flushSection = () => {
    flushAtom();
    const first = atoms[0];
    const last = atoms.at(-1);
    if (first === undefined || last === undefined) return;

    sections.push(
      Object.freeze({
        from: first.from,
        to: last.to,
        totalTokens: atoms.reduce((sum, atom) => sum + atom.tokens, 0),
        atomCount: atoms.length,
        ...(atoms.length === 1
          ? {}
          : { atoms: Object.freeze(atoms) }),
      }),
    );
    atoms = [];
  };

  for (const entry of entries) {
    if (entry.visibleKind === "compressible" && entry.tokens <= 0) {
      continue;
    }

    if (entry.visibleKind === "referable") {
      flushSection();
      continue;
    }

    if (entry.visibleKind === "protected") {
      flushAtom();
      continue;
    }

    // Atoms are always compressible, so the `compressible_` prefix is dropped in
    // the inspect output; the visible kind is recoverable from the range itself.
    const atomId = toVisibleIdLookupKey(entry.id);
    if (currentAtom === undefined) {
      currentAtom = {
        from: atomId,
        to: atomId,
        tokens: entry.tokens,
      };
      continue;
    }

    currentAtom = {
      ...currentAtom,
      to: atomId,
      tokens: currentAtom.tokens + entry.tokens,
    };
  }

  flushSection();
  return Object.freeze(
    sections.sort((left, right) => right.totalTokens - left.totalTokens),
  );
}

function inspectVisibleEntriesInRange(input: {
  readonly projectedMessages: readonly ProjectedPromptMessage[];
  readonly policies: readonly MessageProjectionPolicy[];
  readonly from?: string;
  readonly to: string;
}): readonly CompressionInspectVisibleEntry[] {
  const entries = collectProjectedEntries(input.projectedMessages, input.policies);
  const range = parseInclusiveVisibleRange({
    policies: input.policies,
    entries,
    from: input.from,
    to: input.to,
  });

  return Object.freeze(
    entries.filter((entry) => {
      const visibleSeq = parseVisibleId(entry.id).visibleSeq;
      return (
        visibleSeq >= range.startVisibleSeq &&
        visibleSeq <= range.endVisibleSeq
      );
    }),
  );
}

function collectProjectedEntries(
  messages: readonly ProjectedPromptMessage[],
  policies: readonly MessageProjectionPolicy[],
  countVisibleText = false,
): readonly CompressionInspectVisibleEntry[] {
  const policiesByCanonicalId = new Map(
    policies.map((policy) => [policy.canonicalId, policy]),
  );

  return Object.freeze(
    messages.flatMap((message) => {
      if (message.visibleId === undefined || message.visibleKind === undefined) {
        return [];
      }

      const policy =
        message.canonicalId === undefined
          ? undefined
          : policiesByCanonicalId.get(message.canonicalId);
      if (
        message.visibleKind === "compressible" &&
        !countVisibleText &&
        (policy === undefined || policy.tokenCount <= 0)
      ) {
        return [];
      }
      return [
        Object.freeze({
          id: message.visibleId,
          visibleKind: message.visibleKind,
          role: message.role,
          tokens: countVisibleText
            ? (message.visibleTokenCount ?? Math.ceil(message.contentText.length / 4))
            : message.visibleKind === "compressible"
              ? (policy?.tokenCount ?? 0)
              : 0,
        } satisfies CompressionInspectVisibleEntry),
      ];
    }),
  );
}

function parseInclusiveVisibleRange(input: {
  readonly policies: readonly MessageProjectionPolicy[];
  readonly entries: readonly CompressionInspectVisibleEntry[];
  readonly from?: string;
  readonly to: string;
}): { readonly startVisibleSeq: number; readonly endVisibleSeq: number } {
  const visibleSeqByKey = new Map([
    ...input.policies.map(
      (policy) =>
        [toVisibleIdLookupKey(policy.visibleId), policy.visibleSeq] as const,
    ),
    ...input.entries.map(
      (entry) =>
        [
          toVisibleIdLookupKey(entry.id),
          parseVisibleId(entry.id).visibleSeq,
        ] as const,
    ),
  ]);
  const endVisibleSeq = visibleSeqByKey.get(toVisibleIdLookupKey(input.to));
  if (endVisibleSeq === undefined) {
    throw new Error("compression_inspect targets an unknown visible-id range.");
  }

  let startVisibleSeq: number;
  if (input.from !== undefined) {
    startVisibleSeq =
      visibleSeqByKey.get(toVisibleIdLookupKey(input.from)) ?? -1;
    if (startVisibleSeq < 0) {
      throw new Error("compression_inspect targets an unknown visible-id range.");
    }
  } else {
    const firstCompressible = input.policies.find(
      (policy) => policy.visibleKind === "compressible",
    );
    startVisibleSeq = firstCompressible?.visibleSeq ?? 1;
  }

  if (startVisibleSeq > endVisibleSeq) {
    throw new Error("compression_inspect from/to range is reversed.");
  }

  return { startVisibleSeq, endVisibleSeq };
}

function toVisibleIdLookupKey(visibleId: string): string {
  const parsed = parseVisibleId(visibleId);
  return `${String(parsed.visibleSeq).padStart(6, "0")}_${parsed.suffix}`;
}
