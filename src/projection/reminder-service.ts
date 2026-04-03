import type { ProjectionPolicy } from "./policy-engine.js";

export type ReminderSeverity = "soft" | "hard";

export interface ReminderCadence {
  readonly softMessageCount?: number;
  readonly hardMessageCount?: number;
}

export interface DerivedReminder {
  readonly severity: ReminderSeverity;
  readonly anchorHostMessageID: string;
  readonly anchorVisibleMessageID: string;
  readonly visibleMessageID: string;
  readonly anchorIndex: number;
  readonly text: string;
}

export function deriveReminder(options: {
  readonly policy: ProjectionPolicy;
  readonly cadence?: ReminderCadence;
}): DerivedReminder | undefined {
  const cadence = normalizeReminderCadence(options.cadence);
  const eligibleMessages = options.policy.messages.filter((message) => message.identity.role !== "tool");

  const hardThreshold = cadence.hardMessageCount;
  if (hardThreshold !== undefined && eligibleMessages.length >= hardThreshold) {
    const anchor = eligibleMessages[hardThreshold - 1];
    if (anchor !== undefined) {
      return createReminder("hard", anchor);
    }
  }

  const softThreshold = cadence.softMessageCount;
  if (softThreshold !== undefined && eligibleMessages.length >= softThreshold) {
    const anchor = eligibleMessages[softThreshold - 1];
    if (anchor !== undefined) {
      return createReminder("soft", anchor);
    }
  }

  return undefined;
}

function normalizeReminderCadence(cadence: ReminderCadence | undefined): ReminderCadence {
  if (cadence === undefined) {
    return {
      softMessageCount: 12,
      hardMessageCount: 24,
    };
  }

  return {
    softMessageCount: normalizePositiveInteger(cadence.softMessageCount, "softMessageCount"),
    hardMessageCount: normalizePositiveInteger(cadence.hardMessageCount, "hardMessageCount"),
  };
}

function normalizePositiveInteger(value: number | undefined, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Reminder cadence '${fieldName}' must be a positive integer. Received: ${value}`);
  }

  return value;
}

function createReminder(
  severity: ReminderSeverity,
  anchor: ProjectionPolicy["messages"][number],
): DerivedReminder {
  return {
    severity,
    anchorHostMessageID: anchor.identity.hostMessageID,
    anchorVisibleMessageID: anchor.visible.visibleMessageID,
    visibleMessageID: `${anchor.visible.visibleMessageID}.${severity}`,
    anchorIndex: anchor.index,
    text:
      severity === "hard"
        ? "Reminder: compact older compressible context now unless it must remain verbatim."
        : "Reminder: consider compacting older compressible context when it is no longer needed verbatim.",
  };
}
