import type { Hooks } from "@opencode-ai/plugin";
import { defineInternalModuleContract } from "../internal/module-contract.js";
import {
  type ReplayedHistory,
} from "../history/history-replay-reader.js";
import {
  type CanonicalIdentityService,
} from "../identity/canonical-identity.js";
import {
  deriveStableVisibleSuffix,
  formatVisibleId,
} from "../identity/visible-sequence.js";
import {
  createFlatPolicyEngine,
  type PolicyEngine,
} from "../projection/policy-engine.js";
import type { MarkTreeNode } from "../projection/types.js";
import type { CompleteResultGroup } from "../state/result-group-repository.js";
import {
  readSessionFileLock,
  type SessionFileLockState,
} from "./file-lock.js";
import {
  buildReplayedHistoryFromSessionMessages,
  type SessionHistoryReader,
} from "./session-history.js";

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
  readonly uncompressedMarkedTokenCount: number;
  readonly markedTokenAutoCompactionThreshold: number;
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

export interface HistoryBackedChatParamsSchedulerOptions {
  readonly lockDirectory: string;
  readonly schedulerMarkThreshold?: number;
  readonly markedTokenAutoCompactionThreshold?: number;
  readonly readSessionMessages: SessionHistoryReader["readSessionMessages"];
  readonly loadCommittedResultGroups?: (
    sessionId: string,
    startSeq: number,
    endSeq: number,
  ) => Promise<readonly CompleteResultGroup[]> | readonly CompleteResultGroup[];
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
      const hasQueuedMarks = evaluation.eligibleMarkIds.length > 0;
      const reachedMarkedTokenThreshold =
        evaluation.uncompressedMarkedTokenCount >=
        evaluation.markedTokenAutoCompactionThreshold;

      if (evaluation.activeCompactionLock) {
        return {
          scheduled: false,
          reason:
            "active compaction lock already owns the current frozen batch snapshot",
          metadata: buildMetadata({
            schedulerState:
              hasQueuedMarks && reachedMarkedTokenThreshold ? "eligible" : "idle",
            scheduled: false,
            reason:
              hasQueuedMarks
                ? reachedMarkedTokenThreshold
                  ? "compaction is already running; newly replayed marks stay queued for the next batch"
                  : "compaction is already running; queued marks have not yet reached the marked-token threshold"
                : "compaction is already running and there are no queued marks yet",
            activeCompactionLock: true,
            eligibleMarkIds: evaluation.eligibleMarkIds,
          }),
        };
      }

      if (!hasQueuedMarks) {
        return {
          scheduled: false,
          reason: "no unresolved replayed marks are currently queued for compaction",
          metadata: buildMetadata({
            schedulerState: "idle",
            scheduled: false,
            reason: "no unresolved replayed marks are currently queued for compaction",
            activeCompactionLock: false,
            eligibleMarkIds: evaluation.eligibleMarkIds,
          }),
        };
      }

      if (!reachedMarkedTokenThreshold) {
        return {
          scheduled: false,
          reason:
            "queued replayed marks have not yet reached the marked-token auto-compaction threshold",
          metadata: buildMetadata({
            schedulerState: "idle",
            scheduled: false,
            reason:
              "queued replayed marks have not yet reached the marked-token auto-compaction threshold",
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
  const canonicalIdentityService = options.canonicalIdentityService;

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

        const rangeStart = history.messages[0]?.sequence ?? 1;
        const rangeEnd = history.messages.at(-1)?.sequence ?? 0;
        const committedResultGroups =
          rangeEnd >= rangeStart
            ? await (options.loadCommittedResultGroups?.(
                sessionId,
                rangeStart,
                rangeEnd,
              ) ?? [])
            : [];

        const eligibility = await collectEligibleMarkIds({
          history,
          policyEngine,
          canonicalIdentityService,
          schedulerMarkThreshold: options.schedulerMarkThreshold,
          markedTokenAutoCompactionThreshold:
            options.markedTokenAutoCompactionThreshold,
          committedResultGroups,
        });

        return {
          activeCompactionLock: isActiveCompactionLockState(lockState),
          eligibleMarkIds: eligibility.eligibleMarkIds,
          uncompressedMarkedTokenCount: eligibility.uncompressedMarkedTokenCount,
          markedTokenAutoCompactionThreshold:
            eligibility.markedTokenAutoCompactionThreshold,
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
  return buildReplayedHistoryFromSessionMessages(input);
}

async function collectEligibleMarkIds(input: {
  readonly history: ReplayedHistory;
  readonly policyEngine: PolicyEngine;
  readonly canonicalIdentityService?: CanonicalIdentityService;
  readonly schedulerMarkThreshold?: number;
  readonly markedTokenAutoCompactionThreshold?: number;
  readonly committedResultGroups: readonly CompleteResultGroup[];
}): Promise<{
  readonly eligibleMarkIds: readonly string[];
  readonly uncompressedMarkedTokenCount: number;
  readonly markedTokenAutoCompactionThreshold: number;
}> {
  const messagePolicies = await Promise.all(
    input.policyEngine.classifyMessages(input.history).map(async (policy) => ({
      ...policy,
      visibleId: input.canonicalIdentityService
        ? (
            await input.canonicalIdentityService.allocateVisibleId(
              policy.canonicalId,
              policy.visibleKind,
            )
          ).assignedVisibleId
        : formatVisibleId(
            policy.visibleKind,
            policy.sequence,
            deriveStableVisibleSuffix(policy.canonicalId),
          ),
    })),
  );

  const tree = input.policyEngine.buildMarkTree({
    history: input.history,
    visibleIdsByCanonicalId: new Map(
      messagePolicies.map((policy) => [policy.canonicalId, policy.visibleId]),
    ),
  });

  const resultGroupsByMarkId = new Map(
    input.committedResultGroups.map((group) => [group.markId, group]),
  );
  const tokenCountBySequence = new Map(
    messagePolicies.map((policy) => [policy.sequence, policy.tokenCount]),
  );
  const eligibleMarkIds = collectQueuedMarkIds(tree.marks, resultGroupsByMarkId);
  const markCountThreshold = optionsOrDefault(input.schedulerMarkThreshold, 1);
  const markedTokenThreshold = optionsOrDefault(
    input.markedTokenAutoCompactionThreshold,
    20_000,
  );
  const uncompressedMarkedTokenCount = sumUncompressedMarkedTokens(
    tree.marks,
    resultGroupsByMarkId,
    tokenCountBySequence,
  );

  return Object.freeze({
    eligibleMarkIds:
      eligibleMarkIds.length >= markCountThreshold
        ? Object.freeze(eligibleMarkIds)
        : Object.freeze([]),
    uncompressedMarkedTokenCount,
    markedTokenAutoCompactionThreshold: markedTokenThreshold,
  });
}

function collectQueuedMarkIds(
  marks: readonly MarkTreeNode[],
  resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>,
): string[] {
  const ids: string[] = [];

  const visit = (nodes: readonly MarkTreeNode[]) => {
    for (const node of nodes) {
      if (resultGroupsByMarkId.has(node.markId)) {
        continue;
      }

      ids.push(node.markId);
      visit(node.children);
    }
  };

  visit(marks);
  return ids;
}

function sumUncompressedMarkedTokens(
  marks: readonly MarkTreeNode[],
  resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>,
  tokenCountBySequence: ReadonlyMap<number, number>,
): number {
  return marks.reduce(
    (total, node) =>
      total +
      countUncompressedTokens(node, resultGroupsByMarkId, tokenCountBySequence),
    0,
  );
}

function countUncompressedTokens(
  node: MarkTreeNode,
  resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>,
  tokenCountBySequence: ReadonlyMap<number, number>,
): number {
  if (resultGroupsByMarkId.has(node.markId)) {
    return 0;
  }

  const ownRangeTokens = sumRangeTokens(
    node.startSequence,
    node.endSequence,
    tokenCountBySequence,
  );
  const childCompressedTokens = node.children.reduce(
    (total, child) =>
      total + countCompressedTokens(child, resultGroupsByMarkId, tokenCountBySequence),
    0,
  );

  return Math.max(0, ownRangeTokens - childCompressedTokens);
}

function countCompressedTokens(
  node: MarkTreeNode,
  resultGroupsByMarkId: ReadonlyMap<string, CompleteResultGroup>,
  tokenCountBySequence: ReadonlyMap<number, number>,
): number {
  if (resultGroupsByMarkId.has(node.markId)) {
    return sumRangeTokens(node.startSequence, node.endSequence, tokenCountBySequence);
  }

  return node.children.reduce(
    (total, child) =>
      total + countCompressedTokens(child, resultGroupsByMarkId, tokenCountBySequence),
    0,
  );
}

function sumRangeTokens(
  startSequence: number,
  endSequence: number,
  tokenCountBySequence: ReadonlyMap<number, number>,
): number {
  let total = 0;

  for (let sequence = startSequence; sequence <= endSequence; sequence += 1) {
    total += tokenCountBySequence.get(sequence) ?? 0;
  }

  return total;
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

function optionsOrDefault(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? value
    : fallback;
}

export function isActiveCompactionLockState(state: SessionFileLockState): boolean {
  return state.kind === "running";
}
