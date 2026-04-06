import type { Hooks } from "@opencode-ai/plugin";

import { defineInternalModuleContract } from "../internal/module-contract.js";

type ChatParamsHook = NonNullable<Hooks["chat.params"]>;

export type ChatParamsInput = Parameters<ChatParamsHook>[0];
export type ChatParamsOutput = Parameters<ChatParamsHook>[1];

export const CHAT_PARAMS_METADATA_KEY = "opencodeContextCompression";

export interface ChatParamsSchedulingMetadata {
  readonly contractVersion: "v1";
  readonly schedulerState: "idle" | "eligible" | "scheduled";
  readonly scheduled: boolean;
  readonly reason: string;
}

export interface ChatParamsSchedulerDecision {
  readonly metadata: ChatParamsSchedulingMetadata;
}

export interface ChatParamsSchedulerService {
  schedule(
    input: ChatParamsInput,
  ):
    | Promise<ChatParamsSchedulerDecision>
    | ChatParamsSchedulerDecision;
}

export interface ChatParamsExternalContract {
  readonly seam: "chat.params";
  readonly inputShape: "session metadata plus host message context";
  readonly outputShape: "small scheduler metadata under output.options";
  readonly callTiming: "during provider parameter preparation";
  readonly visibleSideEffects: readonly [
    "writes narrow scheduler metadata only",
    "must not rewrite messages reminders or visible ids"
  ];
  readonly errorSemantics: readonly [
    "scheduler failures may throw before request dispatch",
    "must not become a projection or rendering channel"
  ];
  readonly relationToRuntime: {
    readonly replay: "does not replay or materialize transcript state";
    readonly resultGroups: "does not read or render result-groups";
    readonly scheduler: "is the narrow scheduling and runtime metadata seam";
  };
}

export interface SchedulerDecision {
  readonly scheduled: boolean;
  readonly reason: string;
  readonly metadata?: ChatParamsSchedulingMetadata;
}

export interface ChatParamsScheduler {
  scheduleIfNeeded(sessionId: string): Promise<SchedulerDecision>;
}

export const CHAT_PARAMS_SCHEDULER_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "ChatParamsScheduler",
    inputs: ["sessionId"],
    outputs: ["SchedulerDecision"],
    mutability: "read-only",
    reads: ["runtime config thresholds", "replay-derived eligibility signals"],
    writes: [],
    errorTypes: ["SESSION_NOT_READY"],
    idempotency:
      "Deterministic for the same scheduler inputs and current runtime state.",
    dependencyDirection: {
      inboundFrom: ["external-adapters"],
      outboundTo: [],
    },
  });

export const CHAT_PARAMS_EXTERNAL_CONTRACT = Object.freeze({
  seam: "chat.params",
  inputShape: "session metadata plus host message context",
  outputShape: "small scheduler metadata under output.options",
  callTiming: "during provider parameter preparation",
  visibleSideEffects: [
    "writes narrow scheduler metadata only",
    "must not rewrite messages reminders or visible ids",
  ],
  errorSemantics: [
    "scheduler failures may throw before request dispatch",
    "must not become a projection or rendering channel",
  ],
  relationToRuntime: {
    replay: "does not replay or materialize transcript state",
    resultGroups: "does not read or render result-groups",
    scheduler: "is the narrow scheduling and runtime metadata seam",
  },
} satisfies ChatParamsExternalContract);

export function createStaticChatParamsScheduler(
  metadata: ChatParamsSchedulingMetadata = {
    contractVersion: "v1",
    schedulerState: "idle",
    scheduled: false,
    reason: "scheduler seam not dispatched by the Task 6 contract adapter",
  },
): ChatParamsSchedulerService {
  return {
    schedule() {
      return { metadata };
    },
  } satisfies ChatParamsSchedulerService;
}

export function createStaticInternalChatParamsScheduler(
  decision: SchedulerDecision = {
    scheduled: false,
    reason: "scheduler contract not yet executing runtime scheduling semantics",
  },
): ChatParamsScheduler {
  return {
    async scheduleIfNeeded() {
      return decision;
    },
  } satisfies ChatParamsScheduler;
}

export function createChatParamsSchedulerHook(options: {
  readonly scheduler?: ChatParamsSchedulerService;
} = {}): ChatParamsHook {
  const scheduler = options.scheduler ?? createStaticChatParamsScheduler();

  return async (input, output) => {
    const decision = await scheduler.schedule(input);
    output.options[CHAT_PARAMS_METADATA_KEY] = decision.metadata;
  };
}
