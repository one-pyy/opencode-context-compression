import { buildReferableMarkerIds, parseVisibleId } from "../identity/visible-sequence.js";
import type { CompleteResultGroup } from "../state/result-group-repository.js";

export function buildProjectedReferableMarkers(
  group: Pick<CompleteResultGroup, "markId">,
  fragment: CompleteResultGroup["fragments"][number],
  visibleIdAtSequence: (sequence: number) => string | undefined,
) {
  const startId = visibleIdAtSequence(fragment.sourceStartSeq);
  const endId = visibleIdAtSequence(fragment.sourceEndSeq);
  if (startId === undefined || endId === undefined) return undefined;

  // Stored source coordinates stay in replay space; only displayed endpoints change.
  return buildReferableMarkerIds({
    markId: group.markId,
    fragmentIndex: fragment.fragmentIndex,
    sourceStartSeq: parseVisibleId(startId).visibleSeq,
    sourceEndSeq: parseVisibleId(endId).visibleSeq,
  });
}
