import type { Hooks } from "@opencode-ai/plugin";
import type { Message, Part, ToolPart } from "@opencode-ai/sdk";

import { defineInternalModuleContract } from "../internal/module-contract.js";
import {
  createHistoryReplayReaderFromSources,
  type CanonicalHostMessage,
  type ReplayableCompressionMarkToolEntry,
  type ReplayableHostHistoryEntry,
  type ReplayedHistory,
} from "../history/history-replay-reader.js";
import {
  createCanonicalIdentityService,
  type CanonicalIdentityService,
} from "../identity/canonical-identity.js";
import {
  createFlatPolicyEngine,
  type PolicyEngine,
} from "../projection/policy-engine.js";
import type { MarkTreeNode } from "../projection/types.js";
import {
  deserializeCompressionMarkResult,
  validateCompressionMarkInput,
} from "../tools/compression-mark.js";
import {
  readSessionFileLock,
  type SessionFileLockState,
} from "./file-lock.js";

type ChatParamsHook = NonNullable<Hooks["chat.params"]>;

export type ChatParamsInput = Parameters<ChatParamsHook>[0];
export type ChatParamsOutput = Parameters<ChatParamsHook>[1];

export const CHAT_PARAMS_METADATA_KEY = "opencodeContextCompression";

export interface FrozenCompactionBatchSnapshot {
  readonly markIds: readonly string[];
  readonly markCount: number;
  readonly dispatchedAt: string;
}

export interface ChatParamsSchedulingMetadata {
  readonly contractVersion: "v1";
  readonly schedulerState: "idle" | "eligible" | "scheduled";
  readonly scheduled: boolean;
  readonly reason: string;
  readonly activeCompactionLock: boolean;
  readonly pendingMarkCount: number;
  readonly dispatchedBatch?: FrozenCompactionBatchSnapshot;
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

export interface InternalSchedulerEvaluation {
  readonly activeCompactionLock: boolean;
  readonly eligibleMarkIds: readonly string[];
}

export interface ChatParamsSchedulerDispatchResult {
  readonly scheduled: boolean;
  readonly reason: string;
  readonly dispatchedBatch?: FrozenCompactionBatchSnapshot;
}

export interface InternalChatParamsSchedulerDependencies {
  readonly evaluate: (
    sessionId: string,
  ) =>
    | Promise<InternalSchedulerEvaluation>
    | InternalSchedulerEvaluation;
  readonly dispatch?: (
    input: {
      readonly sessionId: string;
      readonly eligibleMarkIds: readonly string[];
    },
  ) =>
    | Promise<ChatParamsSchedulerDispatchResult>
    | ChatParamsSchedulerDispatchResult;
}

export interface SessionMessageEnvelope {
  readonly info: Message;
  readonly parts: readonly Part[];
}

export interface SessionHistoryReader {
  readSessionMessages(
    sessionId: string,
  ):
    | Promise<readonly SessionMessageEnvelope[]>
    | readonly SessionMessageEnvelope[];
}

export interface HistoryBackedChatParamsSchedulerOptions {
  readonly lockDirectory: string;
  readonly schedulerMarkThreshold?: number;
  readonly readSessionMessages: SessionHistoryReader["readSessionMessages"];
  readonly now?: () => string;
  readonly readLockNow?: () => number;
  readonly policyEngine?: PolicyEngine;
  readonly canonicalIdentityService?: CanonicalIdentityService;
  readonly dispatch?: InternalChatParamsSchedulerDependencies["dispatch"];
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
    activeCompactionLock: false,
    pendingMarkCount: 0,
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

export function createInternalChatParamsScheduler(
  dependencies: InternalChatParamsSchedulerDependencies,
  options: {
    readonly now?: () => string;
  } = {},
): ChatParamsScheduler {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async scheduleIfNeeded(sessionId) {
      const evaluation = await dependencies.evaluate(sessionId);
      if (evaluation.activeCompactionLock) {
        return {
          scheduled: false,
          reason:
            "active compaction lock already owns the current frozen batch snapshot",
          metadata: buildMetadata({
            schedulerState: evaluation.eligibleMarkIds.length > 0 ? "eligible" : "idle",
            scheduled: false,
            reason:
              evaluation.eligibleMarkIds.length > 0
                ? "compaction is already running; newly replayed marks stay queued for the next batch"
                : "compaction is already running and there are no eligible queued marks yet",
            activeCompactionLock: true,
            eligibleMarkIds: evaluation.eligibleMarkIds,
          }),
        };
      }

      if (evaluation.eligibleMarkIds.length === 0) {
        return {
          scheduled: false,
          reason: "no unresolved replayed marks reached the scheduler threshold",
          metadata: buildMetadata({
            schedulerState: "idle",
            scheduled: false,
            reason: "no unresolved replayed marks reached the scheduler threshold",
            activeCompactionLock: false,
            eligibleMarkIds: evaluation.eligibleMarkIds,
          }),
        };
      }

      const dispatch =
        dependencies.dispatch ??
        ((input) => ({
          scheduled: true,
          reason: "froze the current replay-derived mark set for compaction dispatch",
          dispatchedBatch: Object.freeze({
            markIds: Object.freeze([...input.eligibleMarkIds]),
            markCount: input.eligibleMarkIds.length,
            dispatchedAt: now(),
          } satisfies FrozenCompactionBatchSnapshot),
        } satisfies ChatParamsSchedulerDispatchResult));

      const dispatched = await dispatch({
        sessionId,
        eligibleMarkIds: evaluation.eligibleMarkIds,
      });

      return {
        scheduled: dispatched.scheduled,
        reason: dispatched.reason,
        metadata: buildMetadata({
          schedulerState: dispatched.scheduled ? "scheduled" : "eligible",
          scheduled: dispatched.scheduled,
          reason: dispatched.reason,
          activeCompactionLock: false,
          eligibleMarkIds: evaluation.eligibleMarkIds,
          dispatchedBatch: dispatched.dispatchedBatch,
        }),
      };
    },
  } satisfies ChatParamsScheduler;
}

export function createHistoryBackedChatParamsScheduler(
  options: HistoryBackedChatParamsSchedulerOptions,
): ChatParamsScheduler {
  const policyEngine = options.policyEngine ?? createFlatPolicyEngine();
  const canonicalIdentityService =
    options.canonicalIdentityService ??
    createCanonicalIdentityService({
      visibleIds: {
        allocateVisibleId(input) {
          return Object.freeze({
            canonicalId: input.canonicalId,
            visibleKind: input.visibleKind,
            visibleSeq: Number.MAX_SAFE_INTEGER,
            visibleBase62: "runtime",
            assignedVisibleId: input.canonicalId,
            allocatedAt: input.allocatedAt,
          });
        },
      },
      allocateAt: options.now,
    });

  return createInternalChatParamsScheduler(
    {
      async evaluate(sessionId) {
        const [lockState, history] = await Promise.all([
          readSessionFileLock({
            lockDirectory: options.lockDirectory,
            sessionID: sessionId,
            now: options.readLockNow,
          }),
          buildReplayedHistory({
            sessionId,
            readSessionMessages: options.readSessionMessages,
          }),
        ]);

        const eligibleMarkIds = await collectEligibleMarkIds({
          history,
          policyEngine,
          canonicalIdentityService,
          schedulerMarkThreshold: options.schedulerMarkThreshold,
        });

        return {
          activeCompactionLock: isActiveCompactionLockState(lockState),
          eligibleMarkIds,
        } satisfies InternalSchedulerEvaluation;
      },
      dispatch: options.dispatch,
    },
    {
      now: options.now,
    },
  );
}

export function createRuntimeChatParamsSchedulerService(options: {
  readonly scheduler: ChatParamsScheduler;
}): ChatParamsSchedulerService {
  return {
    async schedule(input) {
      const decision = await options.scheduler.scheduleIfNeeded(input.sessionID);
      return {
        metadata:
          decision.metadata ??
          buildMetadata({
            schedulerState: decision.scheduled ? "scheduled" : "idle",
            scheduled: decision.scheduled,
            reason: decision.reason,
            activeCompactionLock: false,
            eligibleMarkIds: [],
          }),
      } satisfies ChatParamsSchedulerDecision;
    },
  } satisfies ChatParamsSchedulerService;
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

async function buildReplayedHistory(input: {
  readonly sessionId: string;
  readonly readSessionMessages: SessionHistoryReader["readSessionMessages"];
}): Promise<ReplayedHistory> {
  const reader = createHistoryReplayReaderFromSources(async (sessionId) => {
    const envelopes = await input.readSessionMessages(sessionId);
    return {
      sessionId,
      hostHistory: collectReplayableHostHistory(envelopes),
      toolHistory: collectReplayableCompressionMarkHistory(envelopes),
    };
  });

  return reader.read(input.sessionId);
}

function collectReplayableHostHistory(
  envelopes: readonly SessionMessageEnvelope[],
): readonly ReplayableHostHistoryEntry[] {
  let sequence = 1;

  return Object.freeze(
    envelopes
      .filter((envelope) => isCanonicalHostMessageRole(envelope.info.role))
      .map((envelope) =>
        Object.freeze({
          sequence: sequence++,
          message: {
            info: {
              id: envelope.info.id,
              role: envelope.info.role,
            },
            parts: envelope.parts.flatMap((part) =>
              part.type === "text"
                ? [
                    {
                      type: "text" as const,
                      text: part.text,
                      messageId: part.messageID,
                    },
                  ]
                : [],
            ),
          } satisfies CanonicalHostMessage,
        } satisfies ReplayableHostHistoryEntry),
      ),
  );
}

function collectReplayableCompressionMarkHistory(
  envelopes: readonly SessionMessageEnvelope[],
): readonly ReplayableCompressionMarkToolEntry[] {
  const sequenceByMessageId = new Map<string, number>();
  let nextSequence = 1;

  for (const envelope of envelopes) {
    if (!isCanonicalHostMessageRole(envelope.info.role)) {
      continue;
    }

    sequenceByMessageId.set(envelope.info.id, nextSequence++);
  }

  const entries: ReplayableCompressionMarkToolEntry[] = [];
  for (const envelope of envelopes) {
    for (const part of envelope.parts) {
      if (!isCompressionMarkToolPart(part)) {
        continue;
      }

      const completedState = part.state.status === "completed" ? part.state : null;
      if (!completedState) {
        continue;
      }

      const parsedInput = validateCompressionMarkInput(completedState.input);
      if (!parsedInput.ok) {
        continue;
      }

      let parsedResult: ReturnType<typeof deserializeCompressionMarkResult>;
      try {
        parsedResult = deserializeCompressionMarkResult(completedState.output);
      } catch {
        continue;
      }

      entries.push(
        Object.freeze({
          sequence: sequenceByMessageId.get(part.messageID) ?? Number.MAX_SAFE_INTEGER,
          sourceMessageId: part.messageID,
          toolName: "compression_mark",
          input: parsedInput.value,
          result: parsedResult,
        } satisfies ReplayableCompressionMarkToolEntry),
      );
    }
  }

  return Object.freeze(entries.sort((left, right) => left.sequence - right.sequence));
}

async function collectEligibleMarkIds(input: {
  readonly history: ReplayedHistory;
  readonly policyEngine: PolicyEngine;
  readonly canonicalIdentityService: CanonicalIdentityService;
  readonly schedulerMarkThreshold?: number;
}): Promise<readonly string[]> {
  const messagePolicies = await Promise.all(
    input.policyEngine.classifyMessages(input.history).map(async (policy) => ({
      ...policy,
      visibleId: (
        await input.canonicalIdentityService.allocateVisibleId(
          policy.canonicalId,
          policy.visibleKind,
        )
      ).assignedVisibleId,
    })),
  );

  const tree = input.policyEngine.buildMarkTree({
    history: input.history,
    visibleIdsByCanonicalId: new Map(
      messagePolicies.map((policy) => [policy.canonicalId, policy.visibleId]),
    ),
  });

  const eligibleMarkIds = flattenMarkIds(tree.marks);
  const threshold = optionsOrDefault(input.schedulerMarkThreshold, 1);

  return eligibleMarkIds.length >= threshold
    ? Object.freeze(eligibleMarkIds)
    : Object.freeze([]);
}

function flattenMarkIds(marks: readonly MarkTreeNode[]): string[] {
  const ids: string[] = [];

  const visit = (nodes: readonly MarkTreeNode[]) => {
    for (const node of nodes) {
      ids.push(node.markId);
      visit(node.children);
    }
  };

  visit(marks);
  return ids;
}

function buildMetadata(input: {
  readonly schedulerState: ChatParamsSchedulingMetadata["schedulerState"];
  readonly scheduled: boolean;
  readonly reason: string;
  readonly activeCompactionLock: boolean;
  readonly eligibleMarkIds: readonly string[];
  readonly dispatchedBatch?: FrozenCompactionBatchSnapshot;
}): ChatParamsSchedulingMetadata {
  return Object.freeze({
    contractVersion: "v1",
    schedulerState: input.schedulerState,
    scheduled: input.scheduled,
    reason: input.reason,
    activeCompactionLock: input.activeCompactionLock,
    pendingMarkCount: input.eligibleMarkIds.length,
    ...(input.dispatchedBatch ? { dispatchedBatch: input.dispatchedBatch } : {}),
  });
}

function isCanonicalHostMessageRole(
  role: Message["role"],
): role is Extract<CanonicalHostMessage["info"]["role"], "user" | "assistant"> {
  return role === "user" || role === "assistant";
}

function isCompressionMarkToolPart(part: Part): part is ToolPart {
  return part.type === "tool" && part.tool === "compression_mark";
}

function optionsOrDefault(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

export function isActiveCompactionLockState(state: SessionFileLockState): boolean {
  return state.kind === "running";
}
