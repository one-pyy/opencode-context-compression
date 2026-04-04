import {
  computeSourceFingerprint,
  type JsonValue,
  type MarkRecord,
  type SqliteSessionStateStore,
  type SourceSnapshotMessageInput,
} from "../state/store.js";

export interface MarkSourceMessageSelection {
  readonly hostMessageID: string;
  readonly role?: string;
  readonly canonicalMessageID?: string;
  readonly contentHash?: string;
  readonly metadata?: JsonValue;
}

export interface CapturedMarkSourceMessage extends SourceSnapshotMessageInput {
  readonly hostMessageID: string;
  readonly role: string;
  readonly canonicalMessageID: string;
}

export interface CapturedMarkSourceSnapshot {
  readonly allowDelete: boolean;
  readonly sourceFingerprint: string;
  readonly canonicalRevision?: string;
  readonly metadata?: JsonValue;
  readonly messages: readonly CapturedMarkSourceMessage[];
}

export interface CaptureMarkSourceSnapshotOptions {
  readonly store: SqliteSessionStateStore;
  readonly allowDelete: boolean;
  readonly sourceMessages: readonly MarkSourceMessageSelection[];
  readonly canonicalRevision?: string;
  readonly sourceFingerprint?: string;
  readonly snapshotMetadata?: JsonValue;
}

export interface PersistMarkOptions extends CaptureMarkSourceSnapshotOptions {
  readonly markID: string;
  readonly toolCallMessageID: string;
  readonly markLabel?: string;
  readonly createdAtMs?: number;
  readonly metadata?: JsonValue;
  readonly snapshotID?: string;
}

export interface PersistMarkResult {
  readonly mark: MarkRecord;
  readonly sourceSnapshot: CapturedMarkSourceSnapshot;
}

export function captureMarkSourceSnapshot(
  options: CaptureMarkSourceSnapshotOptions,
): CapturedMarkSourceSnapshot {
  const messages = options.sourceMessages.map((message) =>
    normalizeMarkSourceMessage(options.store, message),
  );

  return {
    allowDelete: options.allowDelete,
    sourceFingerprint:
      options.sourceFingerprint ??
      computeSourceFingerprint(options.allowDelete, messages),
    canonicalRevision:
      options.canonicalRevision ??
      options.store.getSessionState().lastCanonicalRevision,
    metadata: options.snapshotMetadata,
    messages,
  };
}

export function persistMark(options: PersistMarkOptions): PersistMarkResult {
  const sourceSnapshot = captureMarkSourceSnapshot(options);
  const mark = options.store.createMark({
    markID: options.markID,
    toolCallMessageID: options.toolCallMessageID,
    allowDelete: options.allowDelete,
    markLabel: options.markLabel,
    createdAtMs: options.createdAtMs,
    metadata: options.metadata,
    sourceSnapshot: {
      snapshotID: options.snapshotID,
      sourceFingerprint: sourceSnapshot.sourceFingerprint,
      canonicalRevision: sourceSnapshot.canonicalRevision,
      metadata: sourceSnapshot.metadata,
      messages: sourceSnapshot.messages,
    },
  });

  return {
    mark,
    sourceSnapshot,
  };
}

function normalizeMarkSourceMessage(
  store: SqliteSessionStateStore,
  message: MarkSourceMessageSelection,
): CapturedMarkSourceMessage {
  const hostMessage = store.getHostMessage(message.hostMessageID);
  if (hostMessage === undefined) {
    throw new Error(
      `Unknown host message '${message.hostMessageID}'. Sync canonical host history first.`,
    );
  }

  const role = message.role ?? hostMessage.role;
  if (role !== hostMessage.role) {
    throw new Error(
      `Mark source role mismatch for host message '${message.hostMessageID}': '${role}' !== '${hostMessage.role}'.`,
    );
  }

  const canonicalMessageID =
    message.canonicalMessageID ?? hostMessage.canonicalMessageID;
  if (canonicalMessageID !== hostMessage.canonicalMessageID) {
    throw new Error(
      `Mark source canonical id mismatch for host message '${message.hostMessageID}': '${canonicalMessageID}' !== '${hostMessage.canonicalMessageID}'.`,
    );
  }

  return {
    hostMessageID: hostMessage.hostMessageID,
    canonicalMessageID,
    role,
    contentHash: message.contentHash,
    metadata: message.metadata,
  };
}
