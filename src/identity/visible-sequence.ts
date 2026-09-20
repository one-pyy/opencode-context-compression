import { createHash } from "node:crypto";

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const DEFAULT_VISIBLE_SUFFIX_LENGTH = 2;

export interface ParsedVisibleId {
  readonly kind: string;
  readonly visibleSeq: number;
  readonly suffix: string;
}

export function deriveStableVisibleSuffix(
  stableKey: string,
  suffixLength = DEFAULT_VISIBLE_SUFFIX_LENGTH,
): string {
  let value = BigInt(
    `0x${createHash("sha256").update(stableKey, "utf8").digest("hex")}`,
  );
  let encoded = "";

  while (value > 0n) {
    const remainder = Number(value % 62n);
    encoded = `${BASE62_ALPHABET[remainder]}${encoded}`;
    value /= 62n;
  }

  return (encoded || "0").slice(-suffixLength).padStart(suffixLength, "0");
}

export function formatVisibleId(
  visibleKind: string,
  visibleSeq: number,
  visibleSuffix: string,
): string {
  return `${visibleKind}_${String(visibleSeq).padStart(6, "0")}_${visibleSuffix}`;
}

export function buildStableVisibleId(
  visibleKind: string,
  visibleSeq: number,
  stableKey: string,
): string {
  return formatVisibleId(
    visibleKind,
    visibleSeq,
    deriveStableVisibleSuffix(stableKey),
  );
}

export function prependVisibleId(
  visibleId: string,
  contentText: string,
): string {
  const prefix = `[${visibleId}]`;
  return contentText.trim().length === 0 ? prefix : `${prefix} ${contentText}`;
}

export function prependVisibleIdRange(
  startSeq: number,
  endSeq: number,
  stableKey: string,
  contentText: string,
): string {
  if (startSeq === endSeq) {
    const visibleId = buildStableVisibleId("referable", startSeq, stableKey);
    return prependVisibleId(visibleId, contentText);
  }

  const startId = buildStableVisibleId("referable", startSeq, stableKey);
  const endId = buildStableVisibleId("referable", endSeq, stableKey);
  const prefix = `[${startId}~${endId}]`;
  return contentText.trim().length === 0 ? prefix : `${prefix} ${contentText}`;
}

export interface ReferableMarkerIds {
  readonly stableKey: string;
  readonly startId: string;
  readonly endId: string;
}

// Shared by rendering and mark endpoint resolution so both sides derive the
// same referable marker ids for a result fragment.
export function buildReferableMarkerIds(input: {
  readonly markId: string;
  readonly fragmentIndex: number;
  readonly sourceStartSeq: number;
  readonly sourceEndSeq: number;
}): ReferableMarkerIds {
  const stableKey = `${input.markId}:${input.fragmentIndex}`;
  return Object.freeze({
    stableKey,
    startId: buildStableVisibleId("referable", input.sourceStartSeq, stableKey),
    endId: buildStableVisibleId("referable", input.sourceEndSeq, stableKey),
  } satisfies ReferableMarkerIds);
}

const DEFAULT_BARE_VISIBLE_KIND = "compressible";

export function parseVisibleId(visibleId: string): ParsedVisibleId {
  const segments = visibleId.split("_");
  const firstSegment = segments[0];
  // A bare `<seq6>_<base62>` id omits the visible-type segment. For host
  // endpoints the type is display-only, so a bare id resolves to the same
  // `seq6 + base62` key. It must not default to `referable`, which is the only
  // kind that selects a different resolution path.
  const isBare = firstSegment !== undefined && /^\d+$/u.test(firstSegment);
  const kind = isBare ? DEFAULT_BARE_VISIBLE_KIND : (firstSegment ?? "");
  const visibleSeq = Number.parseInt((isBare ? firstSegment : segments[1]) ?? "", 10);
  const suffix = (isBare ? segments.slice(1) : segments.slice(2)).join("_");

  if (!kind || !Number.isInteger(visibleSeq) || visibleSeq < 1 || !suffix) {
    throw new Error(`Invalid visible id '${visibleId}'.`);
  }

  return Object.freeze({
    kind,
    visibleSeq,
    suffix,
  } satisfies ParsedVisibleId);
}
