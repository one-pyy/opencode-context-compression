import type { VisibleSequenceStore, VisibleMessageIdentity } from "../identity/visible-sequence.js";
import { ensureVisibleMessageIdentity } from "../identity/visible-sequence.js";
import {
  resolveHostMessageCanonicalIdentity,
  type HostBackedCanonicalIdentity,
} from "../identity/canonical-identity.js";
import type { TransformEnvelope } from "../seams/noop-observation.js";

export type ProjectionVisibleState = "protected" | "referable" | "compressible";
export type CanonicalProjectionVisibleState = Extract<ProjectionVisibleState, "protected" | "compressible">;

export interface CanonicalProjectionMessage {
  readonly envelope: TransformEnvelope;
  readonly index: number;
  readonly identity: HostBackedCanonicalIdentity;
  readonly visible: VisibleMessageIdentity;
  readonly visibleState: CanonicalProjectionVisibleState;
}

export interface ProjectionPolicy {
  readonly messages: readonly CanonicalProjectionMessage[];
  readonly byHostMessageID: ReadonlyMap<string, CanonicalProjectionMessage>;
}

export interface BuildProjectionPolicyOptions {
  readonly messages: readonly TransformEnvelope[];
  readonly store: VisibleSequenceStore;
}

export function buildProjectionPolicy(options: BuildProjectionPolicyOptions): ProjectionPolicy {
  const messages = options.messages.map((envelope, index) => {
    const identity = resolveHostMessageCanonicalIdentity(envelope);

    return {
      envelope,
      index,
      identity,
      visible: ensureVisibleMessageIdentity(options.store, identity),
      visibleState: classifyCanonicalMessage(envelope),
    } satisfies CanonicalProjectionMessage;
  });

  return {
    messages,
    byHostMessageID: new Map(messages.map((message) => [message.identity.hostMessageID, message])),
  };
}

function classifyCanonicalMessage(envelope: TransformEnvelope): CanonicalProjectionVisibleState {
  return (envelope.info as Record<string, unknown>).role === "system" ? "protected" : "compressible";
}
