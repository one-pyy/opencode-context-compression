import type {
  VisibleSequenceStore,
  VisibleMessageIdentity,
} from "../identity/visible-sequence.js";
import { ensureVisibleMessageIdentity } from "../identity/visible-sequence.js";
import {
  resolveHostMessageCanonicalIdentity,
  type HostBackedCanonicalIdentity,
} from "../identity/canonical-identity.js";
import type { TransformEnvelope } from "../seams/noop-observation.js";

export type ProjectionVisibleState = "protected" | "referable" | "compressible";
export type CanonicalProjectionVisibleState = Extract<
  ProjectionVisibleState,
  "protected" | "compressible"
>;

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
  readonly smallUserMessageThreshold?: number;
}

export function buildProjectionPolicy(
  options: BuildProjectionPolicyOptions,
): ProjectionPolicy {
  const messages = options.messages.map((envelope, index) => {
    const identity = resolveHostMessageCanonicalIdentity(envelope);

    return {
      envelope,
      index,
      identity,
      visible: ensureVisibleMessageIdentity(options.store, identity),
      visibleState: classifyCanonicalMessage(
        envelope,
        options.smallUserMessageThreshold,
      ),
    } satisfies CanonicalProjectionMessage;
  });

  return {
    messages,
    byHostMessageID: new Map(
      messages.map((message) => [message.identity.hostMessageID, message]),
    ),
  };
}

function classifyCanonicalMessage(
  envelope: TransformEnvelope,
  smallUserMessageThreshold = 0,
): CanonicalProjectionVisibleState {
  const role = (envelope.info as Record<string, unknown>).role;
  if (role === "system") {
    return "protected";
  }

  if (
    role === "user" &&
    readMessageTextLength(envelope) <= smallUserMessageThreshold
  ) {
    return "protected";
  }

  return "compressible";
}

function readMessageTextLength(envelope: TransformEnvelope): number {
  return envelope.parts.reduce((total, part) => {
    if (
      part.type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      return total + (part as { text: string }).text.length;
    }

    return total;
  }, 0);
}
