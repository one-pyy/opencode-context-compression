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

export function parseVisibleId(visibleId: string): ParsedVisibleId {
  const [kind, seq, ...suffixParts] = visibleId.split("_");
  const visibleSeq = Number.parseInt(seq ?? "", 10);
  const suffix = suffixParts.join("_");

  if (!kind || !Number.isInteger(visibleSeq) || visibleSeq < 1 || !suffix) {
    throw new Error(`Invalid visible id '${visibleId}'.`);
  }

  return Object.freeze({
    kind,
    visibleSeq,
    suffix,
  } satisfies ParsedVisibleId);
}
