import { defineInternalModuleContract } from "../internal/module-contract.js";
import type { CanonicalIdentityService } from "../identity/canonical-identity.js";
import type { VisibleIdAllocation } from "../identity/visible-id.js";
import type { HistoryReplayReader } from "../history/history-replay-reader.js";
import type { ResultGroupRepository } from "../state/result-group-repository.js";
import type { PolicyEngine } from "./policy-engine.js";
import { renderProjectionMessages } from "./rendering.js";
import { buildCompressionInspectOverrides } from "./compression-inspect.js";
import type { ReminderService } from "./reminder-service.js";
import type {
  MessageProjectionPolicy,
  MessageProjectionPolicySeed,
  ProjectedPromptMessage,
  ProjectedMessageSet,
  ProjectionBuildInput,
  ReminderArtifact,
  ProjectionState,
  ToolMessageFailure,
  ToolResultOverride,
} from "./types.js";

export interface ProjectionBuilder {
  build(input: ProjectionBuildInput): Promise<ProjectedMessageSet>;
}

export interface ProjectionBuilderDependencies {
  readonly historyReplayReader: HistoryReplayReader;
  readonly policyEngine: PolicyEngine;
  readonly resultGroupRepository: ResultGroupRepository;
  readonly canonicalIdentityService: CanonicalIdentityService;
  readonly reminderService: ReminderService;
  readonly leadingUserPromptText?: string;
}

export const PROJECTION_BUILDER_INTERNAL_CONTRACT =
  defineInternalModuleContract({
    module: "ProjectionBuilder",
    inputs: ["ProjectionBuildInput"],
    outputs: ["ProjectedMessageSet"],
    mutability: "read-only",
    reads: [
      "canonical history replay",
      "result-group read model",
      "visible-id allocations",
      "policy/reminder outputs",
    ],
    writes: [],
    errorTypes: ["OVERLAP_CONFLICT", "RESULT_GROUP_INCOMPLETE"],
    idempotency:
      "Deterministic for the same replayed history, committed result groups, and visible-id allocations.",
    dependencyDirection: {
      inboundFrom: ["external-adapters"],
      outboundTo: [
        "HistoryReplayReader",
        "PolicyEngine",
        "ResultGroupRepository",
        "CanonicalIdentityService",
        "ReminderService",
      ],
    },
  });

export function createProjectionBuilder(
  dependencies: ProjectionBuilderDependencies,
): ProjectionBuilder {
  return {
    async build(input) {
      const history = await dependencies.historyReplayReader.read(input.sessionId);
      const messagePolicies = await hydrateMessagePolicies(
        dependencies.canonicalIdentityService,
        await dependencies.policyEngine.classifyMessages(history),
      );
      const visibleIdAllocations = Object.freeze(
        messagePolicies.map(toVisibleIdAllocation),
      );
      const markTree = dependencies.policyEngine.buildMarkTree({
        history,
        visibleIdsByCanonicalId: new Map(
          messagePolicies.map((policy) => [policy.canonicalId, policy.visibleId]),
        ),
      });
      const conflicts = dependencies.policyEngine.detectConflicts(markTree);
      const rangeStart = history.messages[0]?.sequence ?? 1;
      const rangeEnd = history.messages.at(-1)?.sequence ?? 0;
      const resultGroups =
        rangeEnd >= rangeStart
          ? await dependencies.resultGroupRepository.listGroupsOverlappingRange(
              rangeStart,
              rangeEnd,
            )
          : [];

      const failedToolMessageIds = new Map<string, ToolMessageFailure>();
      
      // Source 1: deterministic conflicts from accepted marks
      history.marks.forEach(mark => {
        const conflict = conflicts.find(c => c.markId === mark.markId);
        if (conflict) {
          failedToolMessageIds.set(mark.sourceMessageId, {
            errorCode: conflict.errorCode,
            message: conflict.message,
            details: {
              markId: mark.markId,
              sourceMessageId: mark.sourceMessageId,
              reason: "mark-tree-conflict",
            },
          });
        }
      });
      
      // Source 2: directly rejected / invalid tool calls (not in history.marks)
      history.compressionMarkToolCalls.forEach(call => {
        if (call.outcome === "accepted") return;
        if (failedToolMessageIds.has(call.sourceMessageId)) return;
        failedToolMessageIds.set(call.sourceMessageId, {
          errorCode: call.errorCode ?? "COMPACTION_FAILED",
          message: call.message ?? `compression_mark call was ${call.outcome}.`,
          details: {
            sourceMessageId: call.sourceMessageId,
            outcome: call.outcome,
            ...(call.mode === undefined ? {} : { mode: call.mode }),
            ...(call.startVisibleMessageId === undefined
              ? {}
              : { startVisibleMessageId: call.startVisibleMessageId }),
            ...(call.endVisibleMessageId === undefined
              ? {}
              : { endVisibleMessageId: call.endVisibleMessageId }),
          },
        });
      });

      const renderedBaseMessages = renderProjectionMessages({
        history,
        messagePolicies,
        markTree,
        resultGroupsByMarkId: new Map(
          resultGroups.map((resultGroup) => [resultGroup.markId, resultGroup]),
        ),
        failedToolMessageIds,
      }).messages;

      const state = {
        sessionId: input.sessionId,
        history,
        markTree,
        conflicts,
        messagePolicies,
        visibleIdAllocations,
        resultGroups,
        failedToolMessageIds,
      } satisfies ProjectionState;
      const toolResultOverrides = Object.freeze([
        ...buildToolResultOverrides(failedToolMessageIds),
        ...buildCompressionInspectOverrides(state),
      ]);
      const reminders = dependencies.reminderService.compute({
        state,
        messages: renderedBaseMessages,
      });

      return {
        sessionId: input.sessionId,
        messages: Object.freeze(
          prependLeadingUserPrompt(
            injectReminderArtifacts(renderedBaseMessages, reminders),
            dependencies.leadingUserPromptText,
          ),
        ),
        toolResultOverrides,
        reminders,
        conflicts,
        state,
      } satisfies ProjectedMessageSet;
    },
  } satisfies ProjectionBuilder;
}

function buildToolResultOverrides(
  failedToolMessageIds: ReadonlyMap<string, ToolMessageFailure>,
): readonly ToolResultOverride[] {
  return Object.freeze(
    [...failedToolMessageIds].map(([sourceMessageId, failure]) =>
      Object.freeze({
        sourceMessageId,
        toolName: "compression_mark",
        output: stringifyToolMessageFailure(failure),
      } satisfies ToolResultOverride),
    ),
  );
}

function stringifyToolMessageFailure(failure: ToolMessageFailure): string {
  return JSON.stringify({
    ok: false,
    errorCode: failure.errorCode,
    message: failure.message,
    ...(failure.details === undefined ? {} : { details: failure.details }),
  });
}

async function hydrateMessagePolicies(
  canonicalIdentityService: CanonicalIdentityService,
  policies: readonly MessageProjectionPolicySeed[],
): Promise<readonly MessageProjectionPolicy[]> {
  return Object.freeze(
    await Promise.all(
      policies.map(async (policy) => {
        const allocation = await canonicalIdentityService.allocateVisibleId(
          policy.canonicalId,
          policy.visibleKind,
        );

        return Object.freeze({
          ...policy,
          visibleId: allocation.assignedVisibleId,
          visibleSeq: allocation.visibleSeq,
          visibleBase62: allocation.visibleBase62,
        } satisfies MessageProjectionPolicy);
      }),
    ),
  );
}

function toVisibleIdAllocation(
  policy: MessageProjectionPolicy,
): VisibleIdAllocation {
  return Object.freeze({
    canonicalId: policy.canonicalId,
    visibleKind: policy.visibleKind,
    visibleSeq: policy.visibleSeq,
    visibleBase62: policy.visibleBase62,
    assignedVisibleId: policy.visibleId,
    allocatedAt: "projection-replay",
  } satisfies VisibleIdAllocation);
}

function injectReminderArtifacts(
  messages: readonly ProjectedPromptMessage[],
  reminders: readonly ReminderArtifact[],
): ProjectedPromptMessage[] {
  const remindersByAnchor = new Map<string, ReminderArtifact[]>();
  reminders.forEach((reminder) => {
    const bucket = remindersByAnchor.get(reminder.anchorCanonicalId) ?? [];
    bucket.push(reminder);
    remindersByAnchor.set(reminder.anchorCanonicalId, bucket);
  });

  const projected: ProjectedPromptMessage[] = [];
  messages.forEach((message) => {
    projected.push(message);
    if (!message.canonicalId) {
      return;
    }

    const anchoredReminders = remindersByAnchor.get(message.canonicalId) ?? [];
    anchoredReminders.forEach((reminder) => {
      projected.push(
        Object.freeze({
          source: "reminder",
          role: "user",
          visibleId: reminder.visibleId,
          contentText: reminder.contentText,
        } satisfies ProjectedPromptMessage),
      );
    });
  });

  return projected;
}

function prependLeadingUserPrompt(
  messages: readonly ProjectedPromptMessage[],
  leadingUserPromptText?: string,
): ProjectedPromptMessage[] {
  if (!leadingUserPromptText || leadingUserPromptText.trim().length === 0) {
    return [...messages];
  }

  return [
    Object.freeze({
      source: "synthetic",
      role: "user",
      contentText: leadingUserPromptText.trim(),
    } satisfies ProjectedPromptMessage),
    ...messages,
  ];
}
