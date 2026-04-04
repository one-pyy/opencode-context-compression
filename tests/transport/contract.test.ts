import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACTION_TRANSPORT_CONTRACT,
  ORDINARY_SESSION_PROMPT_EVIDENCE,
  assessCompactionTransport,
  classifyCompactionTransportFailure,
  type CompactionTransportCandidate,
} from "../../src/transport/contract";

test("independent plugin-owned transport satisfies the compaction contract", () => {
  const candidate: CompactionTransportCandidate = {
    id: "plugin.compaction.invoke",
    owner: "plugin",
    entrypoint: "independent-model-call",
    promptContext: "dedicated-compaction-prompt",
    sessionEffects: {
      createsUserMessage: false,
      reusesSharedLoop: false,
      dependsOnBusyState: false,
      mutatesPermissions: false,
    },
    failureClassification: "deterministic",
  };

  const assessment = assessCompactionTransport(candidate);

  assert.equal(assessment.safeDefault, true);
  assert.deepEqual(assessment.reasons, []);
  assert.equal(COMPACTION_TRANSPORT_CONTRACT.owner, "plugin");
  assert.equal(
    COMPACTION_TRANSPORT_CONTRACT.entrypoint,
    "independent-model-call",
  );
  assert.equal(
    COMPACTION_TRANSPORT_CONTRACT.promptContext,
    "dedicated-compaction-prompt",
  );
});

test("ordinary session.prompt is unsafe as the default compaction transport", () => {
  const candidate: CompactionTransportCandidate = {
    id: "session.prompt",
    owner: "session",
    entrypoint: "session.prompt",
    promptContext: "session-prompt-input",
    sessionEffects: {
      createsUserMessage: true,
      reusesSharedLoop: true,
      dependsOnBusyState: true,
      mutatesPermissions: true,
    },
    failureClassification: "ambient-session-errors",
  };

  const assessment = assessCompactionTransport(candidate);
  const reasonCodes = assessment.reasons.map((reason) => reason.code);

  assert.equal(assessment.safeDefault, false);
  assert.deepEqual(reasonCodes, [
    "not-plugin-owned",
    "missing-dedicated-compaction-context",
    "creates-session-user-message",
    "reuses-shared-session-loop",
    "depends-on-session-busy-state",
    "mutates-session-permissions",
    "failure-classification-not-deterministic",
  ]);

  const createsUserMessage = assessment.reasons.find(
    (reason) => reason.code === "creates-session-user-message",
  );
  assert.ok(createsUserMessage);
  assert.deepEqual(
    createsUserMessage.evidence.map((item) => [
      item.filePath,
      item.startLine,
      item.endLine,
    ]),
    [
      [ORDINARY_SESSION_PROMPT_EVIDENCE.sessionPromptRoute.filePath, 783, 820],
      [
        ORDINARY_SESSION_PROMPT_EVIDENCE.promptCreatesUserMessage.filePath,
        162,
        188,
      ],
      [
        ORDINARY_SESSION_PROMPT_EVIDENCE.createUserMessageWritesUserRole
          .filePath,
        993,
        1027,
      ],
    ],
  );
});

test("session.prompt_async stays unsafe because it still delegates into SessionPrompt.prompt", () => {
  const candidate: CompactionTransportCandidate = {
    id: "session.prompt_async",
    owner: "session",
    entrypoint: "session.prompt_async",
    promptContext: "session-prompt-input",
    sessionEffects: {
      createsUserMessage: true,
      reusesSharedLoop: true,
      dependsOnBusyState: true,
      mutatesPermissions: false,
    },
    failureClassification: "ambient-session-errors",
  };

  const assessment = assessCompactionTransport(candidate);
  const ownershipReason = assessment.reasons.find(
    (reason) => reason.code === "not-plugin-owned",
  );
  const loopReason = assessment.reasons.find(
    (reason) => reason.code === "reuses-shared-session-loop",
  );

  assert.equal(assessment.safeDefault, false);
  assert.ok(ownershipReason);
  assert.deepEqual(ownershipReason.evidence, [
    ORDINARY_SESSION_PROMPT_EVIDENCE.sessionPromptAsyncRoute,
  ]);
  assert.ok(loopReason);
  assert.deepEqual(
    loopReason.evidence[0],
    ORDINARY_SESSION_PROMPT_EVIDENCE.sessionPromptAsyncRoute,
  );
  assert.deepEqual(
    loopReason.evidence[1],
    ORDINARY_SESSION_PROMPT_EVIDENCE.promptSharedLoop,
  );
});

test("validation failure classification is deterministic regardless of issue order", () => {
  const first = classifyCompactionTransportFailure({
    kind: "validation",
    issues: [
      "mutates-session-permissions",
      "not-plugin-owned",
      "creates-session-user-message",
      "not-plugin-owned",
    ],
  });
  const second = classifyCompactionTransportFailure({
    kind: "validation",
    issues: [
      "creates-session-user-message",
      "not-plugin-owned",
      "mutates-session-permissions",
    ],
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    code: "transport-contract-violation",
    phase: "selection",
    detail:
      "Compaction transport contract violation: creates-session-user-message, mutates-session-permissions, not-plugin-owned.",
    normalizedIssues: [
      "creates-session-user-message",
      "mutates-session-permissions",
      "not-plugin-owned",
    ],
  });
});

test("invocation failure classification is transport-specific and stable", () => {
  assert.deepEqual(
    classifyCompactionTransportFailure({
      kind: "invocation",
      issue: "aborted",
    }),
    {
      code: "transport-aborted",
      phase: "invocation",
      detail:
        "Compaction transport invocation was aborted before a result was produced.",
      normalizedIssues: [],
    },
  );

  assert.deepEqual(
    classifyCompactionTransportFailure({
      kind: "invocation",
      issue: "unavailable",
    }),
    {
      code: "transport-unavailable",
      phase: "invocation",
      detail: "Compaction transport could not be reached or initialized.",
      normalizedIssues: [],
    },
  );

  assert.deepEqual(
    classifyCompactionTransportFailure({
      kind: "invocation",
      issue: "invalid-response",
    }),
    {
      code: "transport-response-invalid",
      phase: "invocation",
      detail:
        "Compaction transport returned data that does not satisfy the transport contract.",
      normalizedIssues: [],
    },
  );

  assert.deepEqual(
    classifyCompactionTransportFailure({
      kind: "invocation",
      issue: "execution-error",
    }),
    {
      code: "transport-execution-failed",
      phase: "invocation",
      detail:
        "Compaction transport failed after selection but before producing a valid compaction result.",
      normalizedIssues: [],
    },
  );
});
