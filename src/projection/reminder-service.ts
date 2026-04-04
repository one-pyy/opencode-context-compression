import type { ProjectionPolicy } from "./policy-engine.js";
import { estimateEnvelopeTokens } from "../token-estimation.js";

export type ReminderSeverity = "soft" | "hard";

export interface ReminderCadence {
  readonly hsoft?: number;
  readonly hhard?: number;
  readonly counter?: {
    readonly source?: "eligible_messages" | "assistant_turns";
    readonly soft?: {
      readonly repeatEvery?: number;
    };
    readonly hard?: {
      readonly repeatEvery?: number;
    };
  };
}

export interface ReminderTemplates {
  readonly soft: string;
  readonly hard: string;
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
  readonly templates: ReminderTemplates;
  readonly modelName?: string;
}): DerivedReminder | undefined {
  const cadence = normalizeReminderCadence(options.cadence);
  const eligibleMessages = options.policy.messages.filter(
    (message) => message.identity.role !== "tool",
  );
  const eligibleMessageTokenCounts = eligibleMessages.map(
    (message) =>
      estimateEnvelopeTokens({
        envelope: message.envelope,
        modelName: options.modelName,
      }).tokenCount,
  );

  const hardReminderState = deriveReminderState(
    eligibleMessages,
    eligibleMessageTokenCounts,
    cadence,
    "hard",
  );
  if (hardReminderState !== undefined) {
    const anchor = eligibleMessages[hardReminderState.anchorIndex];
    if (anchor !== undefined) {
      return createReminder("hard", anchor, options.templates);
    }
  }

  const softReminderState = deriveReminderState(
    eligibleMessages,
    eligibleMessageTokenCounts,
    cadence,
    "soft",
  );
  if (softReminderState !== undefined) {
    const anchor = eligibleMessages[softReminderState.anchorIndex];
    if (anchor !== undefined) {
      return createReminder("soft", anchor, options.templates);
    }
  }

  return undefined;
}

function normalizeReminderCadence(
  cadence: ReminderCadence | undefined,
): ReminderCadence {
  if (cadence === undefined) {
    return {
      hsoft: 12,
      hhard: 24,
      counter: {
        source: "eligible_messages",
        soft: { repeatEvery: 3 },
        hard: { repeatEvery: 1 },
      },
    };
  }

  return {
    hsoft: normalizePositiveInteger(cadence.hsoft, "hsoft"),
    hhard: normalizePositiveInteger(cadence.hhard, "hhard"),
    counter: {
      source: cadence.counter?.source ?? "eligible_messages",
      soft: {
        repeatEvery: normalizePositiveInteger(
          cadence.counter?.soft?.repeatEvery,
          "counter.soft.repeatEvery",
        ),
      },
      hard: {
        repeatEvery: normalizePositiveInteger(
          cadence.counter?.hard?.repeatEvery,
          "counter.hard.repeatEvery",
        ),
      },
    },
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Reminder cadence '${fieldName}' must be a positive integer. Received: ${value}`,
    );
  }

  return value;
}

function deriveReminderState(
  eligibleMessages: readonly ProjectionPolicy["messages"][number][],
  eligibleMessageTokenCounts: readonly number[],
  cadence: ReminderCadence,
  severity: ReminderSeverity,
): { anchorIndex: number } | undefined {
  const threshold = severity === "hard" ? cadence.hhard : cadence.hsoft;
  if (threshold === undefined) {
    return undefined;
  }

  const counterSource = cadence.counter?.source ?? "eligible_messages";
  const repeatEvery =
    severity === "hard"
      ? (cadence.counter?.hard?.repeatEvery ?? 1)
      : (cadence.counter?.soft?.repeatEvery ?? 1);
  const thresholdIndex = findThresholdCrossingIndex(
    eligibleMessageTokenCounts,
    threshold,
  );
  if (thresholdIndex === undefined) {
    return undefined;
  }

  if (repeatEvery <= 1) {
    return {
      anchorIndex: eligibleMessages.length - 1,
    };
  }

  if (counterSource === "assistant_turns") {
    const assistantCount = countEligibleMessagesSinceThreshold(
      eligibleMessages,
      thresholdIndex,
      "assistant",
    );
    if (assistantCount < 1 || assistantCount % repeatEvery !== 0) {
      return undefined;
    }

    return {
      anchorIndex: eligibleMessages.length - 1,
    };
  }

  const eligibleSinceThreshold = eligibleMessages.length - thresholdIndex;
  if (
    eligibleSinceThreshold < 1 ||
    eligibleSinceThreshold % repeatEvery !== 0
  ) {
    return undefined;
  }

  return {
    anchorIndex: eligibleMessages.length - 1,
  };
}

function findThresholdCrossingIndex(
  tokenCounts: readonly number[],
  threshold: number,
): number | undefined {
  let total = 0;
  for (let index = 0; index < tokenCounts.length; index += 1) {
    total += tokenCounts[index] ?? 0;
    if (total >= threshold) {
      return index;
    }
  }

  return undefined;
}

function countEligibleMessagesSinceThreshold(
  eligibleMessages: readonly ProjectionPolicy["messages"][number][],
  thresholdIndex: number,
  role: string,
): number {
  return eligibleMessages
    .slice(thresholdIndex)
    .filter((message) => message.identity.role === role).length;
}

function createReminder(
  severity: ReminderSeverity,
  anchor: ProjectionPolicy["messages"][number],
  templates: ReminderTemplates,
): DerivedReminder {
  return {
    severity,
    anchorHostMessageID: anchor.identity.hostMessageID,
    anchorVisibleMessageID: anchor.visible.visibleMessageID,
    visibleMessageID: `${anchor.visible.visibleMessageID}.${severity}`,
    anchorIndex: anchor.index,
    text: severity === "hard" ? templates.hard : templates.soft,
  };
}
