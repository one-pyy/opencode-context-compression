import type { ProjectionPolicy } from "./policy-engine.js";
import { estimateEnvelopeTokens } from "../token-estimation.js";

export type ReminderSeverity = "soft" | "hard";

export interface ReminderCadence {
  readonly hsoft?: number;
  readonly hhard?: number;
  readonly softRepeatEveryTokens?: number;
  readonly hardRepeatEveryTokens?: number;
}

export interface ReminderTexts {
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
  readonly texts: ReminderTexts;
  readonly modelName?: string;
}): DerivedReminder | undefined {
  const cadence = normalizeReminderCadence(options.cadence);
  const eligibleMessages = options.policy.messages.filter(
    (message) => message.visibleState === "compressible",
  );
  const eligibleMessageTokenCounts = eligibleMessages.map(
    (message) =>
      estimateEnvelopeTokens({
        envelope: message.envelope,
        modelName: options.modelName,
      }).tokenCount,
  );

  const hardReminderState = deriveReminderState(
    eligibleMessageTokenCounts,
    cadence,
    "hard",
  );
  if (hardReminderState !== undefined) {
    const anchor = eligibleMessages[hardReminderState.anchorIndex];
    if (anchor !== undefined) {
        return createReminder("hard", anchor, options.texts);
    }
  }

  const softReminderState = deriveReminderState(
    eligibleMessageTokenCounts,
    cadence,
    "soft",
  );
  if (softReminderState !== undefined) {
    const anchor = eligibleMessages[softReminderState.anchorIndex];
    if (anchor !== undefined) {
        return createReminder("soft", anchor, options.texts);
    }
  }

  return undefined;
}

function normalizeReminderCadence(
  cadence: ReminderCadence | undefined,
): ReminderCadence {
  if (cadence === undefined) {
    return {
      hsoft: 30_000,
      hhard: 70_000,
      softRepeatEveryTokens: 20_000,
      hardRepeatEveryTokens: 10_000,
    };
  }

  return {
    hsoft: normalizePositiveInteger(cadence.hsoft, "hsoft"),
    hhard: normalizePositiveInteger(cadence.hhard, "hhard"),
    softRepeatEveryTokens: normalizePositiveInteger(
      cadence.softRepeatEveryTokens,
      "softRepeatEveryTokens",
    ),
    hardRepeatEveryTokens: normalizePositiveInteger(
      cadence.hardRepeatEveryTokens,
      "hardRepeatEveryTokens",
    ),
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
  eligibleMessageTokenCounts: readonly number[],
  cadence: ReminderCadence,
  severity: ReminderSeverity,
): { anchorIndex: number } | undefined {
  const threshold = severity === "hard" ? cadence.hhard : cadence.hsoft;
  if (threshold === undefined) {
    return undefined;
  }

  const repeatEvery =
    severity === "hard"
      ? (cadence.hardRepeatEveryTokens ?? 1)
      : (cadence.softRepeatEveryTokens ?? 1);
  const thresholdIndex = findThresholdCrossingIndex(
    eligibleMessageTokenCounts,
    threshold,
  );
  if (thresholdIndex === undefined) {
    return undefined;
  }

  const totalEligibleTokens = totalTokens(eligibleMessageTokenCounts);
  const reminderTokenThreshold =
    severity === "hard" || repeatEvery <= 0
      ? threshold
      : threshold +
        Math.floor(Math.max(totalEligibleTokens - threshold, 0) / repeatEvery) *
          repeatEvery;
  const anchorIndex = findThresholdCrossingIndex(
    eligibleMessageTokenCounts,
    reminderTokenThreshold,
  );
  if (anchorIndex === undefined) {
    return undefined;
  }

  return {
    anchorIndex,
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

function totalTokens(tokenCounts: readonly number[]): number {
  return tokenCounts.reduce((sum, count) => sum + count, 0);
}

function createReminder(
  severity: ReminderSeverity,
  anchor: ProjectionPolicy["messages"][number],
  texts: ReminderTexts,
): DerivedReminder {
  return {
    severity,
    anchorHostMessageID: anchor.identity.hostMessageID,
    anchorVisibleMessageID: anchor.visible.visibleMessageID,
    visibleMessageID: `${anchor.visible.visibleMessageID}.${severity}`,
    anchorIndex: anchor.index,
    text: severity === "hard" ? texts.hard : texts.soft,
  };
}
