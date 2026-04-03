import type {
  CompactionRoute,
  HostMessageRecord,
  JsonValue,
  SourceSnapshotMessageRecord,
  SourceSnapshotRecord,
} from "../state/store.js";

export interface CompactionSourceSnapshotStore {
  getHostMessage(hostMessageID: string): HostMessageRecord | undefined;
  getSourceSnapshot(snapshotID: string): SourceSnapshotRecord | undefined;
  listSourceSnapshotMessages(snapshotID: string): SourceSnapshotMessageRecord[];
}

export interface CanonicalCompactionMessage {
  readonly hostMessageID: string;
  readonly canonicalMessageID: string;
  readonly role: string;
  readonly content: string;
  readonly contentHash?: string;
  readonly metadata?: JsonValue;
}

export interface ResolvedCompactionSourceSnapshot {
  readonly snapshotID: string;
  readonly route: CompactionRoute;
  readonly sourceFingerprint: string;
  readonly canonicalRevision?: string;
  readonly messages: readonly SourceSnapshotMessageRecord[];
}

export interface CompactionInputMessage extends CanonicalCompactionMessage {}

export interface CompactionInput {
  readonly kind: "canonical-source-compaction";
  readonly promptContext: "dedicated-compaction-prompt";
  readonly promptText: string;
  readonly route: CompactionRoute;
  readonly sourceSnapshotID: string;
  readonly sourceFingerprint: string;
  readonly canonicalRevision?: string;
  readonly sourceMessages: readonly CompactionInputMessage[];
  readonly transcript: string;
  readonly metadata?: JsonValue;
}

export interface BuildCompactionInputOptions {
  readonly sourceSnapshot: ResolvedCompactionSourceSnapshot;
  readonly promptText: string;
  readonly canonicalMessages: readonly CanonicalCompactionMessage[];
  readonly metadata?: JsonValue;
}

export type SourceIdentityFailureCode =
  | "missing-live-host-message"
  | "source-no-longer-canonical"
  | "canonical-id-mismatch"
  | "role-mismatch";

export type CanonicalSourceMismatchCode =
  | "duplicate-canonical-message"
  | "missing-source-message"
  | "canonical-id-mismatch"
  | "role-mismatch"
  | "content-hash-mismatch";

export interface SourceIdentityFailure {
  readonly code: SourceIdentityFailureCode;
  readonly detail: string;
  readonly hostMessageID: string;
}

export type SourceIdentityValidationResult =
  | {
      readonly matches: true;
      readonly sourceSnapshot: ResolvedCompactionSourceSnapshot;
    }
  | {
      readonly matches: false;
      readonly sourceSnapshot: ResolvedCompactionSourceSnapshot;
      readonly failure: SourceIdentityFailure;
    };

export class CanonicalSourceMismatchError extends Error {
  readonly code: CanonicalSourceMismatchCode;
  readonly hostMessageID?: string;

  constructor(code: CanonicalSourceMismatchCode, message: string, hostMessageID?: string) {
    super(message);
    this.name = "CanonicalSourceMismatchError";
    this.code = code;
    this.hostMessageID = hostMessageID;
  }
}

export function resolveCompactionSourceSnapshot(
  store: Pick<CompactionSourceSnapshotStore, "getSourceSnapshot" | "listSourceSnapshotMessages">,
  sourceSnapshotID: string,
): ResolvedCompactionSourceSnapshot {
  const sourceSnapshot = store.getSourceSnapshot(sourceSnapshotID);
  if (sourceSnapshot === undefined) {
    throw new Error(`Unknown compaction source snapshot '${sourceSnapshotID}'.`);
  }

  const messages = store.listSourceSnapshotMessages(sourceSnapshotID);
  if (messages.length === 0) {
    throw new Error(`Compaction source snapshot '${sourceSnapshotID}' has no source messages.`);
  }

  return {
    snapshotID: sourceSnapshot.snapshotID,
    route: sourceSnapshot.route,
    sourceFingerprint: sourceSnapshot.sourceFingerprint,
    canonicalRevision: sourceSnapshot.canonicalRevision,
    messages,
  };
}

export function buildCompactionInput(options: BuildCompactionInputOptions): CompactionInput {
  const promptText = normalizePromptText(options.promptText);
  const sourceMessages = resolveCanonicalSourceMessages(
    options.sourceSnapshot.messages,
    options.canonicalMessages,
  );

  return {
    kind: "canonical-source-compaction",
    promptContext: "dedicated-compaction-prompt",
    promptText,
    route: options.sourceSnapshot.route,
    sourceSnapshotID: options.sourceSnapshot.snapshotID,
    sourceFingerprint: options.sourceSnapshot.sourceFingerprint,
    canonicalRevision: options.sourceSnapshot.canonicalRevision,
    sourceMessages,
    transcript: renderCanonicalCompactionTranscript(sourceMessages),
    metadata: options.metadata,
  };
}

export function revalidateCompactionSourceIdentity(
  store: Pick<CompactionSourceSnapshotStore, "getHostMessage" | "getSourceSnapshot" | "listSourceSnapshotMessages">,
  sourceSnapshotID: string,
): SourceIdentityValidationResult {
  const sourceSnapshot = resolveCompactionSourceSnapshot(store, sourceSnapshotID);

  for (const sourceMessage of sourceSnapshot.messages) {
    const liveHostMessage = store.getHostMessage(sourceMessage.hostMessageID);
    if (liveHostMessage === undefined) {
      return {
        matches: false,
        sourceSnapshot,
        failure: {
          code: "missing-live-host-message",
          hostMessageID: sourceMessage.hostMessageID,
          detail: `Canonical host message '${sourceMessage.hostMessageID}' no longer exists.`,
        },
      };
    }

    if (!liveHostMessage.canonicalPresent) {
      return {
        matches: false,
        sourceSnapshot,
        failure: {
          code: "source-no-longer-canonical",
          hostMessageID: sourceMessage.hostMessageID,
          detail: `Canonical host message '${sourceMessage.hostMessageID}' is no longer present in the live canonical source.`,
        },
      };
    }

    if (liveHostMessage.canonicalMessageID !== sourceMessage.canonicalMessageID) {
      return {
        matches: false,
        sourceSnapshot,
        failure: {
          code: "canonical-id-mismatch",
          hostMessageID: sourceMessage.hostMessageID,
          detail:
            `Canonical id mismatch for host message '${sourceMessage.hostMessageID}': ` +
            `'${liveHostMessage.canonicalMessageID}' !== '${sourceMessage.canonicalMessageID}'.`,
        },
      };
    }

    if (liveHostMessage.role !== sourceMessage.hostRole) {
      return {
        matches: false,
        sourceSnapshot,
        failure: {
          code: "role-mismatch",
          hostMessageID: sourceMessage.hostMessageID,
          detail:
            `Role mismatch for host message '${sourceMessage.hostMessageID}': ` +
            `'${liveHostMessage.role}' !== '${sourceMessage.hostRole}'.`,
        },
      };
    }
  }

  return {
    matches: true,
    sourceSnapshot,
  };
}

export function renderCanonicalCompactionTranscript(
  sourceMessages: readonly CanonicalCompactionMessage[],
): string {
  return sourceMessages
    .map(
      (message, index) =>
        [
          `### ${index + 1}. ${message.role} ${message.hostMessageID} (${message.canonicalMessageID})`,
          message.content,
        ].join("\n"),
    )
    .join("\n\n");
}

function resolveCanonicalSourceMessages(
  sourceMessages: readonly SourceSnapshotMessageRecord[],
  canonicalMessages: readonly CanonicalCompactionMessage[],
): readonly CompactionInputMessage[] {
  const canonicalMessageByHostID = new Map<string, CanonicalCompactionMessage>();

  for (const canonicalMessage of canonicalMessages) {
    const existing = canonicalMessageByHostID.get(canonicalMessage.hostMessageID);
    if (existing !== undefined) {
      throw new CanonicalSourceMismatchError(
        "duplicate-canonical-message",
        `Canonical compaction input included duplicate host message '${canonicalMessage.hostMessageID}'.`,
        canonicalMessage.hostMessageID,
      );
    }

    canonicalMessageByHostID.set(canonicalMessage.hostMessageID, canonicalMessage);
  }

  return sourceMessages.map((sourceMessage) => {
    const canonicalMessage = canonicalMessageByHostID.get(sourceMessage.hostMessageID);
    if (canonicalMessage === undefined) {
      throw new CanonicalSourceMismatchError(
        "missing-source-message",
        `Missing canonical content for source host message '${sourceMessage.hostMessageID}'.`,
        sourceMessage.hostMessageID,
      );
    }

    if (canonicalMessage.canonicalMessageID !== sourceMessage.canonicalMessageID) {
      throw new CanonicalSourceMismatchError(
        "canonical-id-mismatch",
        `Canonical id mismatch for source host message '${sourceMessage.hostMessageID}': ` +
          `'${canonicalMessage.canonicalMessageID}' !== '${sourceMessage.canonicalMessageID}'.`,
        sourceMessage.hostMessageID,
      );
    }

    if (canonicalMessage.role !== sourceMessage.hostRole) {
      throw new CanonicalSourceMismatchError(
        "role-mismatch",
        `Role mismatch for source host message '${sourceMessage.hostMessageID}': ` +
          `'${canonicalMessage.role}' !== '${sourceMessage.hostRole}'.`,
        sourceMessage.hostMessageID,
      );
    }

    if (
      sourceMessage.contentHash !== undefined &&
      canonicalMessage.contentHash !== undefined &&
      canonicalMessage.contentHash !== sourceMessage.contentHash
    ) {
      throw new CanonicalSourceMismatchError(
        "content-hash-mismatch",
        `Content hash mismatch for source host message '${sourceMessage.hostMessageID}': ` +
          `'${canonicalMessage.contentHash}' !== '${sourceMessage.contentHash}'.`,
        sourceMessage.hostMessageID,
      );
    }

    return {
      hostMessageID: canonicalMessage.hostMessageID,
      canonicalMessageID: canonicalMessage.canonicalMessageID,
      role: canonicalMessage.role,
      content: canonicalMessage.content,
      contentHash: canonicalMessage.contentHash,
      metadata: canonicalMessage.metadata,
    } satisfies CompactionInputMessage;
  });
}

function normalizePromptText(promptText: string): string {
  if (promptText.trim().length === 0) {
    throw new Error("Compaction input requires a dedicated prompt text.");
  }

  return promptText;
}
