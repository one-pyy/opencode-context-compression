export type CompactionTransportOwner =
  | "plugin"
  | "session"
  | "server"
  | "external";

export type CompactionTransportEntrypoint =
  | "independent-model-call"
  | "session.prompt"
  | "session.prompt_async"
  | "custom";

export type CompactionPromptContext =
  | "dedicated-compaction-prompt"
  | "session-prompt-input"
  | "unknown";

export type FailureClassificationMode =
  | "deterministic"
  | "ambient-session-errors"
  | "unknown";

export interface CompactionTransportEvidence {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly summary: string;
}

export interface CompactionTransportContract {
  readonly owner: "plugin";
  readonly entrypoint: "independent-model-call";
  readonly promptContext: "dedicated-compaction-prompt";
  readonly sessionEffects: {
    readonly createsUserMessage: false;
    readonly reusesSharedLoop: false;
    readonly dependsOnBusyState: false;
    readonly mutatesPermissions: false;
  };
  readonly failureClassification: "deterministic";
}

export interface CompactionTransportCandidate {
  readonly id: string;
  readonly owner: CompactionTransportOwner;
  readonly entrypoint: CompactionTransportEntrypoint;
  readonly promptContext: CompactionPromptContext;
  readonly sessionEffects: {
    readonly createsUserMessage: boolean;
    readonly reusesSharedLoop: boolean;
    readonly dependsOnBusyState: boolean;
    readonly mutatesPermissions: boolean;
  };
  readonly failureClassification: FailureClassificationMode;
}

export type UnsafeDefaultReasonCode =
  | "not-plugin-owned"
  | "missing-dedicated-compaction-context"
  | "creates-session-user-message"
  | "reuses-shared-session-loop"
  | "depends-on-session-busy-state"
  | "mutates-session-permissions"
  | "failure-classification-not-deterministic";

export interface UnsafeDefaultReason {
  readonly code: UnsafeDefaultReasonCode;
  readonly message: string;
  readonly evidence: readonly CompactionTransportEvidence[];
}

export interface CompactionTransportAssessment {
  readonly candidate: CompactionTransportCandidate;
  readonly safeDefault: boolean;
  readonly reasons: readonly UnsafeDefaultReason[];
}

export type CompactionTransportFailureSignal =
  | {
      readonly kind: "validation";
      readonly issues: readonly UnsafeDefaultReasonCode[];
    }
  | {
      readonly kind: "invocation";
      readonly issue:
        | "aborted"
        | "unavailable"
        | "invalid-response"
        | "execution-error";
    };

export type CompactionTransportFailureCode =
  | "transport-contract-violation"
  | "transport-aborted"
  | "transport-unavailable"
  | "transport-response-invalid"
  | "transport-execution-failed";

export interface CompactionTransportFailure {
  readonly code: CompactionTransportFailureCode;
  readonly phase: "selection" | "invocation";
  readonly detail: string;
  readonly normalizedIssues: readonly UnsafeDefaultReasonCode[];
}

const UPSTREAM_SESSION_ROUTE =
  "/root/_/projects/opencode-upstream/packages/opencode/src/server/routes/session.ts";
const UPSTREAM_PROMPT_MODULE =
  "/root/_/projects/opencode-upstream/packages/opencode/src/session/prompt.ts";

export const COMPACTION_TRANSPORT_CONTRACT: CompactionTransportContract =
  Object.freeze({
    owner: "plugin",
    entrypoint: "independent-model-call",
    promptContext: "dedicated-compaction-prompt",
    sessionEffects: Object.freeze({
      createsUserMessage: false,
      reusesSharedLoop: false,
      dependsOnBusyState: false,
      mutatesPermissions: false,
    }),
    failureClassification: "deterministic",
  });

export const ORDINARY_SESSION_PROMPT_EVIDENCE = Object.freeze({
  sessionPromptRoute: Object.freeze({
    filePath: UPSTREAM_SESSION_ROUTE,
    startLine: 783,
    endLine: 820,
    summary:
      "The ordinary session message route streams a response after calling SessionPrompt.prompt for the current session.",
  }),
  sessionPromptAsyncRoute: Object.freeze({
    filePath: UPSTREAM_SESSION_ROUTE,
    startLine: 825,
    endLine: 852,
    summary:
      "The prompt_async route still delegates to SessionPrompt.prompt, only changing when the HTTP caller gets control back.",
  }),
  promptInputSchema: Object.freeze({
    filePath: UPSTREAM_PROMPT_MODULE,
    startLine: 95,
    endLine: 159,
    summary:
      "Ordinary prompt input is shaped as a session prompt payload with agent/tools/system/parts fields, not a dedicated compaction transport contract.",
  }),
  promptCreatesUserMessage: Object.freeze({
    filePath: UPSTREAM_PROMPT_MODULE,
    startLine: 162,
    endLine: 188,
    summary:
      "SessionPrompt.prompt creates a user message before it can continue into the shared loop.",
  }),
  createUserMessageWritesUserRole: Object.freeze({
    filePath: UPSTREAM_PROMPT_MODULE,
    startLine: 993,
    endLine: 1027,
    summary:
      "createUserMessage materializes a role=user session message with agent/model/system metadata.",
  }),
  promptMutatesPermissions: Object.freeze({
    filePath: UPSTREAM_PROMPT_MODULE,
    startLine: 169,
    endLine: 182,
    summary:
      "SessionPrompt.prompt can translate prompt tools into persisted session permissions before the model call runs.",
  }),
  promptSharedLoop: Object.freeze({
    filePath: UPSTREAM_PROMPT_MODULE,
    startLine: 274,
    endLine: 302,
    summary:
      "SessionPrompt.loop reuses session-level abort/callback state, marks the session busy, and reads the session message stream.",
  }),
  promptBusyStateGuard: Object.freeze({
    filePath: UPSTREAM_PROMPT_MODULE,
    startLine: 90,
    endLine: 93,
    summary:
      "SessionPrompt.assertNotBusy rejects work when the session already has prompt state attached.",
  }),
});

const PROMPT_ROUTE_EVIDENCE: Record<
  CompactionTransportEntrypoint,
  readonly CompactionTransportEvidence[]
> = {
  "independent-model-call": [],
  "session.prompt": [ORDINARY_SESSION_PROMPT_EVIDENCE.sessionPromptRoute],
  "session.prompt_async": [
    ORDINARY_SESSION_PROMPT_EVIDENCE.sessionPromptAsyncRoute,
  ],
  custom: [],
};

function uniqueSortedIssues(
  issues: readonly UnsafeDefaultReasonCode[],
): readonly UnsafeDefaultReasonCode[] {
  return [...new Set(issues)].sort();
}

function withRouteEvidence(
  candidate: CompactionTransportCandidate,
  ...evidence: readonly CompactionTransportEvidence[]
): readonly CompactionTransportEvidence[] {
  return [...PROMPT_ROUTE_EVIDENCE[candidate.entrypoint], ...evidence];
}

export function assessCompactionTransport(
  candidate: CompactionTransportCandidate,
): CompactionTransportAssessment {
  const reasons: UnsafeDefaultReason[] = [];

  if (candidate.owner !== COMPACTION_TRANSPORT_CONTRACT.owner) {
    reasons.push({
      code: "not-plugin-owned",
      message:
        "Default compaction transport must stay plugin-owned instead of routing through ordinary session or server prompt entrypoints.",
      evidence: withRouteEvidence(candidate),
    });
  }

  if (candidate.promptContext !== COMPACTION_TRANSPORT_CONTRACT.promptContext) {
    reasons.push({
      code: "missing-dedicated-compaction-context",
      message:
        "Default compaction transport must carry its own compaction prompt/context instead of reusing the ordinary session prompt payload.",
      evidence: withRouteEvidence(
        candidate,
        ORDINARY_SESSION_PROMPT_EVIDENCE.promptInputSchema,
      ),
    });
  }

  if (candidate.sessionEffects.createsUserMessage) {
    reasons.push({
      code: "creates-session-user-message",
      message:
        "Default compaction transport cannot create an ordinary role=user session message as a side effect of invoking compaction.",
      evidence: withRouteEvidence(
        candidate,
        ORDINARY_SESSION_PROMPT_EVIDENCE.promptCreatesUserMessage,
        ORDINARY_SESSION_PROMPT_EVIDENCE.createUserMessageWritesUserRole,
      ),
    });
  }

  if (candidate.sessionEffects.reusesSharedLoop) {
    reasons.push({
      code: "reuses-shared-session-loop",
      message:
        "Default compaction transport must not run inside the ordinary session loop that consumes shared session history and callbacks.",
      evidence: withRouteEvidence(
        candidate,
        ORDINARY_SESSION_PROMPT_EVIDENCE.promptSharedLoop,
      ),
    });
  }

  if (candidate.sessionEffects.dependsOnBusyState) {
    reasons.push({
      code: "depends-on-session-busy-state",
      message:
        "Default compaction transport cannot depend on SessionPrompt busy-state guards or shared prompt callback state.",
      evidence: withRouteEvidence(
        candidate,
        ORDINARY_SESSION_PROMPT_EVIDENCE.promptBusyStateGuard,
        ORDINARY_SESSION_PROMPT_EVIDENCE.promptSharedLoop,
      ),
    });
  }

  if (candidate.sessionEffects.mutatesPermissions) {
    reasons.push({
      code: "mutates-session-permissions",
      message:
        "Default compaction transport cannot rely on the ordinary prompt path because it can persist session permission changes before invocation.",
      evidence: withRouteEvidence(
        candidate,
        ORDINARY_SESSION_PROMPT_EVIDENCE.promptMutatesPermissions,
      ),
    });
  }

  if (
    candidate.failureClassification !==
    COMPACTION_TRANSPORT_CONTRACT.failureClassification
  ) {
    reasons.push({
      code: "failure-classification-not-deterministic",
      message:
        "Default compaction transport must report stable, transport-specific failure categories instead of ambient session prompt failures.",
      evidence: [],
    });
  }

  return {
    candidate,
    safeDefault: reasons.length === 0,
    reasons,
  };
}

export function classifyCompactionTransportFailure(
  signal: CompactionTransportFailureSignal,
): CompactionTransportFailure {
  if (signal.kind === "validation") {
    const normalizedIssues = uniqueSortedIssues(signal.issues);
    const detail =
      normalizedIssues.length === 0
        ? "Compaction transport contract violation."
        : `Compaction transport contract violation: ${normalizedIssues.join(", ")}.`;

    return {
      code: "transport-contract-violation",
      phase: "selection",
      detail,
      normalizedIssues,
    };
  }

  switch (signal.issue) {
    case "aborted":
      return {
        code: "transport-aborted",
        phase: "invocation",
        detail:
          "Compaction transport invocation was aborted before a result was produced.",
        normalizedIssues: [],
      };
    case "unavailable":
      return {
        code: "transport-unavailable",
        phase: "invocation",
        detail: "Compaction transport could not be reached or initialized.",
        normalizedIssues: [],
      };
    case "invalid-response":
      return {
        code: "transport-response-invalid",
        phase: "invocation",
        detail:
          "Compaction transport returned data that does not satisfy the transport contract.",
        normalizedIssues: [],
      };
    case "execution-error":
      return {
        code: "transport-execution-failed",
        phase: "invocation",
        detail:
          "Compaction transport failed after selection but before producing a valid compaction result.",
        normalizedIssues: [],
      };
  }
}
