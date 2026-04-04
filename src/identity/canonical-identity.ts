import type {
  TransformEnvelope,
  TransformMessage,
  TransformPart,
} from "../seams/noop-observation.js";

export interface CanonicalIdentityAnchor {
  readonly hostMessageID: string;
  readonly canonicalMessageID: string;
}

export interface HostBackedCanonicalIdentity extends CanonicalIdentityAnchor {
  readonly role: string;
  readonly sessionID?: string;
  readonly parentID?: string;
  readonly hostCreatedAtMs?: number;
  readonly corroboratingPartMessageIDs: readonly string[];
}

export function resolveHostMessageCanonicalIdentity(
  message: TransformEnvelope,
): HostBackedCanonicalIdentity {
  const canonicalMessageID = requireNonEmptyString(
    message.info.id,
    "message.info.id",
  );
  const corroboratingPartMessageIDs = collectCorroboratingPartMessageIDs(
    message.parts,
  );

  for (const partMessageID of corroboratingPartMessageIDs) {
    if (partMessageID !== canonicalMessageID) {
      throw new Error(
        `Canonical identity mismatch for '${canonicalMessageID}': parts[*].messageID included '${partMessageID}'.`,
      );
    }
  }

  return {
    hostMessageID: canonicalMessageID,
    canonicalMessageID,
    role: requireNonEmptyString(message.info.role, "message.info.role"),
    sessionID: readOptionalString(message.info.sessionID),
    parentID: readOptionalRecordString(message.info, "parentID"),
    hostCreatedAtMs: readCreatedAtMs(message.info),
    corroboratingPartMessageIDs,
  };
}

export function pickEarliestSourceCanonicalIdentity(
  sourceMessages: readonly CanonicalIdentityAnchor[],
): CanonicalIdentityAnchor {
  const earliestSource = sourceMessages[0];
  if (earliestSource === undefined) {
    throw new Error("Referable blocks require at least one source message.");
  }

  return {
    hostMessageID: earliestSource.hostMessageID,
    canonicalMessageID: earliestSource.canonicalMessageID,
  };
}

function collectCorroboratingPartMessageIDs(
  parts: readonly TransformPart[],
): string[] {
  const uniqueMessageIDs = new Set<string>();

  for (const part of parts) {
    const messageID = readOptionalRecordString(part, "messageID");
    if (messageID !== undefined) {
      uniqueMessageIDs.add(messageID);
    }
  }

  return [...uniqueMessageIDs];
}

function readCreatedAtMs(message: TransformMessage): number | undefined {
  const time = message.time;
  if (!time || typeof time !== "object") {
    return undefined;
  }

  const created = (time as Record<string, unknown>).created;
  return typeof created === "number" && Number.isFinite(created)
    ? created
    : undefined;
}

function readOptionalRecordString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Missing canonical identity field '${path}'.`);
}
