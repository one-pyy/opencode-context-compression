import { parseVisibleId } from "../identity/visible-sequence.js";
import type { CompressionMarkInputV1 } from "../tools/compression-mark.js";
import { buildProjectedReferableMarkers } from "./referable-markers.js";
import type { ProjectedMessageSet } from "./types.js";

export type CompressionMarkTokenCounter = (
  input: CompressionMarkInputV1,
) => number | undefined;

export function createCompressionMarkTokenCounter(
  projection: ProjectedMessageSet,
): CompressionMarkTokenCounter {
  const policies = new Map(projection.state.messagePolicies.map((policy) => [policy.canonicalId, policy]));
  const idsBySequence = new Map(projection.state.messagePolicies.map((policy) => [policy.sequence, policy.visibleId]));
  const fragments = new Map<string, { from: string; to: string }>();
  for (const group of projection.state.resultGroups) {
    if (group.mode !== "compact") continue;
    for (const fragment of group.fragments) {
      const markers = buildProjectedReferableMarkers(group, fragment, (sequence) => idsBySequence.get(sequence));
      if (markers) fragments.set(markers.startId, { from: markers.startId, to: markers.endId });
    }
  }
  const endpoints = new Map<string, number>();
  for (const policy of projection.state.messagePolicies) {
    endpoints.set(hostKey(policy.visibleId), policy.visibleSeq);
  }
  const entries = projection.messages.flatMap((message) => {
    if (message.visibleId === undefined || message.role === "system") return [];
    const policy = message.canonicalId === undefined ? undefined : policies.get(message.canonicalId);
    const fragment = message.source === "result-group" ? fragments.get(message.visibleId) : undefined;
    if (policy === undefined && fragment === undefined) return [];
    const from = parseVisibleId(fragment?.from ?? message.visibleId).visibleSeq;
    const to = parseVisibleId(fragment?.to ?? message.visibleId).visibleSeq;
    if (fragment) {
      endpoints.set(fragment.from, from);
      endpoints.set(fragment.to, to);
    }
    return [{
      from,
      to,
      compactTokens: policy?.visibleKind === "compressible" ? policy.tokenCount : 0,
      deleteTokens: message.visibleTokenCount,
    }];
  });

  // Keep only numeric listings and endpoint identities, not whole session projections.
  return (input) => {
    try {
      const resolve = (id: string) => endpoints.get(
        parseVisibleId(id).kind === "referable" ? id : hostKey(id),
      );
      const from = resolve(input.from);
      const to = resolve(input.to);
      if (from === undefined || to === undefined || from > to) return undefined;
      let tokens = 0;
      for (const entry of entries) {
        if (entry.to < from || entry.from > to) continue;
        if (entry.from < from || entry.to > to) return undefined;
        const count = input.mode === "compact" ? entry.compactTokens : entry.deleteTokens;
        if (count === undefined) return undefined;
        tokens += count;
      }
      return tokens;
    } catch {
      return undefined;
    }
  };
}

function hostKey(id: string): string {
  const parsed = parseVisibleId(id);
  return `${parsed.visibleSeq}_${parsed.suffix}`;
}
