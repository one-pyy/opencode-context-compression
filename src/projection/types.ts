import type { ReplayedHistory } from "../history/history-replay-reader.js";
import type { VisibleIdAllocation, VisibleKind } from "../identity/visible-id.js";
import type { CompleteResultGroup } from "../state/result-group-repository.js";

export type ReminderKind =
  | "soft-compact"
  | "soft-delete"
  | "hard-compact"
  | "hard-delete";

export interface MarkTreeNode {
  readonly markId: string;
  readonly mode: "compact" | "delete";
  readonly startVisibleMessageId: string;
  readonly endVisibleMessageId: string;
  readonly sourceMessageId: string;
  readonly sourceSequence: number;
  readonly startSequence: number;
  readonly endSequence: number;
  readonly depth: number;
  readonly children: readonly MarkTreeNode[];
  readonly hint?: string;
}

export interface MarkTree {
  readonly marks: readonly MarkTreeNode[];
  readonly conflicts: readonly ConflictRecord[];
}

export interface ConflictRecord {
  readonly markId: string;
  readonly errorCode: "OVERLAP_CONFLICT";
  readonly message: string;
}

export interface MessageProjectionPolicy {
  readonly canonicalId: string;
  readonly sequence: number;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly visibleKind: VisibleKind;
  readonly tokenCount: number;
  readonly visibleId: string;
  readonly visibleSeq: number;
  readonly visibleBase62: string;
}

export interface MessageProjectionPolicySeed {
  readonly canonicalId: string;
  readonly sequence: number;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly visibleKind: VisibleKind;
  readonly tokenCount: number;
}

export interface ToolMessageFailure {
  readonly errorCode: string;
  readonly message: string;
}

export interface ReminderArtifact {
  readonly kind: ReminderKind;
  readonly anchorCanonicalId: string;
  readonly anchorVisibleId: string;
  readonly visibleId: string;
  readonly contentText: string;
}

export interface ProjectionState {
  readonly sessionId: string;
  readonly history: ReplayedHistory;
  readonly markTree: MarkTree;
  readonly conflicts: readonly ConflictRecord[];
  readonly messagePolicies: readonly MessageProjectionPolicy[];
  readonly visibleIdAllocations: readonly VisibleIdAllocation[];
  readonly resultGroups: readonly CompleteResultGroup[];
  readonly failedToolMessageIds: ReadonlyMap<string, ToolMessageFailure>;
}

export interface ProjectionBuildInput {
  readonly sessionId: string;
}

export interface ProjectedPromptMessage {
  readonly source: "canonical" | "result-group" | "reminder" | "synthetic";
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly canonicalId?: string;
  readonly sourceMarkId?: string;
  readonly visibleKind?: VisibleKind;
  readonly visibleId?: string;
  readonly contentText: string;
  readonly parts?: readonly import("../history/history-replay-reader.js").CanonicalHostMessagePart[];
  readonly hostMessage?: import("../history/history-replay-reader.js").CanonicalHostMessage;
}

export interface ProjectedMessageSet {
  readonly sessionId: string;
  readonly messages: readonly ProjectedPromptMessage[];
  readonly reminders: readonly ReminderArtifact[];
  readonly conflicts: readonly ConflictRecord[];
  readonly state: ProjectionState;
}
