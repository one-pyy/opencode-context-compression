import { createHash } from "node:crypto";

import type { VisibleSequenceAssignment } from "../state/store.js";
import {
  pickEarliestSourceCanonicalIdentity,
  type CanonicalIdentityAnchor,
} from "./canonical-identity.js";

const VISIBLE_SEQUENCE_WIDTH = 6;
const VISIBLE_CHECKSUM_WIDTH = 2;
const VISIBLE_CHECKSUM_MODULUS = 36 ** VISIBLE_CHECKSUM_WIDTH;
const VISIBLE_CHECKSUM_PATTERN = /^[0-9a-z]{2}$/;
const LEGACY_ROLE_PREFIX_PATTERN = /^(?:assistant|user|tool)_/;

export type VisibleRenderState = "protected" | "referable" | "compressible";
export type ReminderVisibleSeverity = "soft" | "hard";

export interface VisibleSequenceStore {
  ensureVisibleSequenceAssignment(input: {
    readonly hostMessageID: string;
    readonly visibleChecksum?: string;
  }): VisibleSequenceAssignment;
}

export interface VisibleMessageIdentity extends CanonicalIdentityAnchor {
  readonly visibleSeq: number;
  readonly visibleChecksum: string;
  readonly visibleMessageID: string;
}

export function ensureVisibleMessageIdentity(
  store: VisibleSequenceStore,
  identity: CanonicalIdentityAnchor,
): VisibleMessageIdentity {
  const visibleChecksum = computeVisibleChecksum(identity.canonicalMessageID);
  const assignment = store.ensureVisibleSequenceAssignment({
    hostMessageID: identity.hostMessageID,
    visibleChecksum,
  });

  return buildVisibleMessageIdentity(
    identity,
    assignment.visibleSeq,
    assignment.visibleChecksum ?? visibleChecksum,
  );
}

export function ensureReferableVisibleMessageIdentity(
  store: VisibleSequenceStore,
  sourceMessages: readonly CanonicalIdentityAnchor[],
): VisibleMessageIdentity {
  return ensureVisibleMessageIdentity(
    store,
    pickEarliestSourceCanonicalIdentity(sourceMessages),
  );
}

export function computeVisibleChecksum(canonicalMessageID: string): string {
  if (canonicalMessageID.length === 0) {
    throw new Error(
      "Visible checksum requires a canonical message identifier.",
    );
  }

  const digest = createHash("sha256").update(canonicalMessageID).digest();
  const checksumValue = digest.readUInt32BE(0) % VISIBLE_CHECKSUM_MODULUS;

  return checksumValue.toString(36).padStart(VISIBLE_CHECKSUM_WIDTH, "0");
}

export function formatBareVisibleMessageID(input: {
  readonly visibleSeq: number;
  readonly visibleChecksum: string;
}): string {
  if (!Number.isInteger(input.visibleSeq) || input.visibleSeq < 1) {
    throw new Error(
      `Visible sequence must be a positive integer. Received: ${input.visibleSeq}`,
    );
  }

  if (!VISIBLE_CHECKSUM_PATTERN.test(input.visibleChecksum)) {
    throw new Error(
      `Visible checksum must be ${VISIBLE_CHECKSUM_WIDTH} lowercase base36 characters. Received: '${input.visibleChecksum}'.`,
    );
  }

  return `${String(input.visibleSeq).padStart(VISIBLE_SEQUENCE_WIDTH, "0")}_${input.visibleChecksum}`;
}

export function formatReminderVisibleMessageID(input: {
  readonly severity: ReminderVisibleSeverity;
  readonly anchorVisibleChecksum: string;
}): string {
  if (!VISIBLE_CHECKSUM_PATTERN.test(input.anchorVisibleChecksum)) {
    throw new Error(
      `Reminder anchor checksum must be ${VISIBLE_CHECKSUM_WIDTH} lowercase base36 characters. Received: '${input.anchorVisibleChecksum}'.`,
    );
  }

  return `reminder_${input.severity}_${input.anchorVisibleChecksum}`;
}

export function renderVisibleIdentityToken(
  visibleState: VisibleRenderState,
  visibleMessageID: string,
): string {
  return `[${visibleState}_${normalizeVisibleMessageIDForRender(visibleMessageID)}]`;
}

export function normalizeVisibleMessageIDForRender(
  visibleMessageID: string,
): string {
  let normalized = visibleMessageID;

  while (true) {
    const statePrefixMatch = /^(protected|referable|compressible)_(.+)$/u.exec(
      normalized,
    );
    if (statePrefixMatch === null) {
      break;
    }

    normalized = statePrefixMatch[2] ?? normalized;
  }

  return normalized.replace(LEGACY_ROLE_PREFIX_PATTERN, "");
}

function buildVisibleMessageIdentity(
  identity: CanonicalIdentityAnchor,
  visibleSeq: number,
  visibleChecksum: string,
): VisibleMessageIdentity {
  return {
    hostMessageID: identity.hostMessageID,
    canonicalMessageID: identity.canonicalMessageID,
    visibleSeq,
    visibleChecksum,
    visibleMessageID: formatBareVisibleMessageID({
      visibleSeq,
      visibleChecksum,
    }),
  };
}
