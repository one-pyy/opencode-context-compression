import { freezeCurrentCompactionBatch } from "../marks/batch-freeze.js";
import { releaseSessionFileLock } from "../runtime/file-lock.js";
import type { RuntimeEventWriter } from "../runtime/runtime-events.js";
import type {
  CompactionBatchMarkRecord,
  CompactionBatchRecord,
  CompactionJobAttemptRecord,
  CompactionJobRecord,
  CompactionRoute,
  JsonValue,
  ReplacementRecord,
  SourceSnapshotMessageRecord,
  SqliteSessionStateStore,
} from "../state/store.js";
import {
  assessCompactionTransport,
  classifyCompactionTransportFailure,
  type CompactionTransportAssessment,
  type CompactionTransportCandidate,
  type CompactionTransportFailure,
} from "../transport/contract.js";
import {
  buildCompactionInput,
  revalidateCompactionSourceIdentity,
  resolveCompactionSourceSnapshot,
  type CanonicalCompactionMessage,
  type CompactionInput,
  type SourceIdentityFailure,
} from "./input-builder.js";
import {
  InvalidCompactionOutputError,
  validateCompactionOutput,
  type RawCompactionOutput,
} from "./output-validation.js";

type Awaitable<T> = T | Promise<T>;

export type CompactionTransportInvocationIssue =
  | "aborted"
  | "unavailable"
  | "invalid-response"
  | "execution-error";

export class CompactionTransportInvocationError extends Error {
  readonly issue: CompactionTransportInvocationIssue;

  constructor(issue: CompactionTransportInvocationIssue, message?: string) {
    super(message ?? `Compaction transport invocation failed: ${issue}.`);
    this.name = "CompactionTransportInvocationError";
    this.issue = issue;
  }
}

export interface CompactionRunnerTransportRequest {
  readonly model: string;
  readonly batchID: string;
  readonly jobID: string;
  readonly markID: string;
  readonly attemptIndex: number;
  readonly input: CompactionInput;
}

export interface CompactionRunnerTransport {
  readonly candidate: CompactionTransportCandidate;
  invoke(request: CompactionRunnerTransportRequest): Awaitable<RawCompactionOutput>;
}

export interface LoadCanonicalSourceMessagesOptions {
  readonly batchID: string;
  readonly jobID: string;
  readonly markID: string;
  readonly route: CompactionRoute;
  readonly sourceSnapshotID: string;
  readonly sourceFingerprint: string;
  readonly sourceMessages: readonly SourceSnapshotMessageRecord[];
}

export interface CompactionRunnerIDFactory {
  makeBatchID(sessionID: string, seed: number): string;
  makeJobID(batchID: string, markID: string, memberIndex: number): string;
  makeReplacementID(jobID: string, attemptIndex: number): string;
  makeGateObservationID(batchID: string, phase: string, ordinal: number): string;
}

export interface RunCompactionBatchOptions {
  readonly store: SqliteSessionStateStore;
  readonly lockDirectory: string;
  readonly sessionID: string;
  readonly promptText: string;
  readonly models: readonly string[];
  readonly transport: CompactionRunnerTransport;
  readonly loadCanonicalSourceMessages: (
    options: LoadCanonicalSourceMessagesOptions,
  ) => Awaitable<readonly CanonicalCompactionMessage[]>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly note?: string;
  readonly metadata?: JsonValue;
  readonly ids?: Partial<CompactionRunnerIDFactory>;
  readonly runtimeEvents?: RuntimeEventWriter;
}

export type CompactionJobFailureCode =
  | CompactionTransportFailure["code"]
  | "source-input-build-failed"
  | "source-revalidation-failed"
  | "stale-attempt-result";

export interface CompactionJobFailure {
  readonly code: CompactionJobFailureCode;
  readonly phase: "selection" | "input" | "invocation" | "commit";
  readonly detail: string;
  readonly normalizedIssues?: readonly string[];
}

export interface CompactionJobExecutionResult {
  readonly job: CompactionJobRecord;
  readonly markID: string;
  readonly attempts: readonly CompactionJobAttemptRecord[];
  readonly replacement?: ReplacementRecord;
  readonly finalFailure?: CompactionJobFailure;
}

export type RunCompactionBatchResult =
  | {
      readonly started: false;
      readonly reason: "no-active-marks";
    }
  | {
      readonly started: false;
      readonly reason: "active-compaction-lock";
      readonly lockPath: string;
      readonly state: Extract<
        Awaited<ReturnType<typeof freezeCurrentCompactionBatch>>,
        { started: false; reason: "active-compaction-lock" }
      >["state"];
    }
  | {
      readonly started: false;
      readonly reason: "invalid-transport";
      readonly assessment: CompactionTransportAssessment;
      readonly failure: CompactionTransportFailure;
    }
  | {
      readonly started: true;
      readonly lockPath: string;
      readonly batch: CompactionBatchRecord;
      readonly batchMembers: readonly CompactionBatchMarkRecord[];
      readonly jobs: readonly CompactionJobExecutionResult[];
      readonly finalStatus: "succeeded" | "failed";
    };

const DEFAULT_ID_FACTORY: CompactionRunnerIDFactory = Object.freeze({
  makeBatchID: (sessionID: string, seed: number) => `${sessionID}:batch:${seed}`,
  makeJobID: (batchID: string, markID: string, memberIndex: number) =>
    `${batchID}:job:${String(memberIndex).padStart(3, "0")}:${markID}`,
  makeReplacementID: (jobID: string, attemptIndex: number) => `${jobID}:replacement:${attemptIndex}`,
  makeGateObservationID: (batchID: string, phase: string, ordinal: number) =>
    `${batchID}:gate:${phase}:${ordinal}`,
});

export async function runCompactionBatch(
  options: RunCompactionBatchOptions,
): Promise<RunCompactionBatchResult> {
  const now = options.now ?? Date.now;
  const models = normalizeModels(options.models);
  const ids = resolveIDFactory(options.ids);
  const transportAssessment = assessCompactionTransport(options.transport.candidate);

  if (!transportAssessment.safeDefault) {
    return {
      started: false,
      reason: "invalid-transport",
      assessment: transportAssessment,
      failure: classifyCompactionTransportFailure({
        kind: "validation",
        issues: transportAssessment.reasons.map((reason) => reason.code),
      }),
    };
  }

  const batchID = ids.makeBatchID(options.sessionID, now());
  const frozen = await freezeCurrentCompactionBatch({
    store: options.store,
    lockDirectory: options.lockDirectory,
    sessionID: options.sessionID,
    batchID,
    metadata: options.metadata,
    note: options.note,
    now,
    timeoutMs: options.timeoutMs,
  });

  if (!frozen.started) {
    if (frozen.reason === "no-active-marks") {
      return frozen;
    }

    return {
      started: false,
      reason: "active-compaction-lock",
      lockPath: frozen.lockPath,
      state: frozen.state,
    };
  }

  const gateObservationCounter = createObservationCounter(batchID, ids);
  let batch = options.store.updateCompactionBatchStatus({
    batchID,
    status: "running",
    metadata: options.metadata,
  });

  const runningObservation = options.store.recordRuntimeGateObservation({
    observationID: gateObservationCounter.next("running"),
    observedState: "running",
    lockPath: frozen.lockPath,
    startedAtMs: frozen.lock.startedAtMs,
    observedAtMs: now(),
    activeJobCount: frozen.persistedMembers.length,
    note: options.note,
    metadata: options.metadata,
  });
  options.runtimeEvents?.recordRuntimeGateObservation(
    {
      observationID: runningObservation.observationID,
      observedState: "running",
      lockPath: frozen.lockPath,
      startedAtMs: frozen.lock.startedAtMs,
      observedAtMs: runningObservation.observedAtMs,
      activeJobCount: frozen.persistedMembers.length,
      note: options.note,
      metadata: options.metadata,
    },
    runningObservation,
  );

  const jobResults: CompactionJobExecutionResult[] = [];
  let finalStatus: "succeeded" | "failed" = "succeeded";
  let finalGateNote = options.note;

  try {
    for (const batchMember of frozen.persistedMembers) {
      const jobID = ids.makeJobID(batchID, batchMember.markID, batchMember.memberIndex);
      const job = options.store.createCompactionJob({
        jobID,
        batchID,
        markID: batchMember.markID,
        status: "running",
        startedAtMs: now(),
      });

      const jobResult = await runCompactionJob({
        store: options.store,
        batchID,
        batchMember,
        job,
        promptText: options.promptText,
        models,
        transport: options.transport,
        loadCanonicalSourceMessages: options.loadCanonicalSourceMessages,
        now,
        ids,
      });

      jobResults.push(jobResult);
      if (jobResult.job.status !== "succeeded") {
        finalStatus = "failed";
        finalGateNote = jobResult.finalFailure?.detail ?? options.note;
        break;
      }
    }

    batch = finalizeBatchStatus(options.store, batchID, finalStatus, options.metadata);

    const finalObservation = options.store.recordRuntimeGateObservation({
      observationID: gateObservationCounter.next(finalStatus),
      observedState: finalStatus,
      lockPath: frozen.lockPath,
      startedAtMs: frozen.lock.startedAtMs,
      settledAtMs: now(),
      observedAtMs: now(),
      activeJobCount: 0,
      note: finalGateNote,
      metadata: options.metadata,
    });
    options.runtimeEvents?.recordRuntimeGateObservation(
      {
        observationID: finalObservation.observationID,
        observedState: finalStatus,
        lockPath: frozen.lockPath,
        startedAtMs: frozen.lock.startedAtMs,
        settledAtMs: finalObservation.settledAtMs,
        observedAtMs: finalObservation.observedAtMs,
        activeJobCount: 0,
        note: finalGateNote,
        metadata: options.metadata,
      },
      finalObservation,
    );

    return {
      started: true,
      lockPath: frozen.lockPath,
      batch,
      batchMembers: frozen.persistedMembers,
      jobs: jobResults,
      finalStatus,
    };
  } finally {
    const releasedAtMs = now();
    await releaseSessionFileLock({
      lockDirectory: options.lockDirectory,
      sessionID: options.sessionID,
    });

    const unlockedObservation = options.store.recordRuntimeGateObservation({
      observationID: gateObservationCounter.next("unlocked"),
      observedState: "unlocked",
      lockPath: frozen.lockPath,
      startedAtMs: frozen.lock.startedAtMs,
      settledAtMs: releasedAtMs,
      observedAtMs: releasedAtMs,
      activeJobCount: 0,
      note: finalGateNote,
      metadata: options.metadata,
    });
    options.runtimeEvents?.recordRuntimeGateObservation(
      {
        observationID: unlockedObservation.observationID,
        observedState: "unlocked",
        lockPath: frozen.lockPath,
        startedAtMs: frozen.lock.startedAtMs,
        settledAtMs: releasedAtMs,
        observedAtMs: releasedAtMs,
        activeJobCount: 0,
        note: finalGateNote,
        metadata: options.metadata,
      },
      unlockedObservation,
    );
  }
}

interface RunCompactionJobInternalOptions {
  readonly store: SqliteSessionStateStore;
  readonly batchID: string;
  readonly batchMember: CompactionBatchMarkRecord;
  readonly job: CompactionJobRecord;
  readonly promptText: string;
  readonly models: readonly string[];
  readonly transport: CompactionRunnerTransport;
  readonly loadCanonicalSourceMessages: RunCompactionBatchOptions["loadCanonicalSourceMessages"];
  readonly now: () => number;
  readonly ids: CompactionRunnerIDFactory;
}

async function runCompactionJob(
  options: RunCompactionJobInternalOptions,
): Promise<CompactionJobExecutionResult> {
  const attempts: CompactionJobAttemptRecord[] = [];
  const sourceSnapshot = resolveCompactionSourceSnapshot(options.store, options.batchMember.sourceSnapshotID);

  const initialIdentity = revalidateCompactionSourceIdentity(options.store, sourceSnapshot.snapshotID);
  if (!initialIdentity.matches) {
    const failure = buildSourceRevalidationFailure(initialIdentity.failure);
    return {
      job: finalizeJobFailure(options.store, options.job.jobID, failure, options.now()),
      markID: options.batchMember.markID,
      attempts,
      finalFailure: failure,
    };
  }

  let input: CompactionInput;
  try {
    const canonicalMessages = await options.loadCanonicalSourceMessages({
      batchID: options.batchID,
      jobID: options.job.jobID,
      markID: options.batchMember.markID,
      route: options.batchMember.route,
      sourceSnapshotID: sourceSnapshot.snapshotID,
      sourceFingerprint: sourceSnapshot.sourceFingerprint,
      sourceMessages: sourceSnapshot.messages,
    });
    input = buildCompactionInput({
      sourceSnapshot,
      promptText: options.promptText,
      canonicalMessages,
    });
  } catch (error) {
    const failure: CompactionJobFailure = {
      code: "source-input-build-failed",
      phase: "input",
      detail: `Failed to build canonical compaction input: ${describeError(error)}`,
    };

    return {
      job: finalizeJobFailure(options.store, options.job.jobID, failure, options.now()),
      markID: options.batchMember.markID,
      attempts,
      finalFailure: failure,
    };
  }

  for (const [modelIndex, modelName] of options.models.entries()) {
    const attemptIndex = attempts.length;
    const attemptStartedAtMs = options.now();
    let validatedOutput: ReturnType<typeof validateCompactionOutput>;

    try {
      const rawOutput = await options.transport.invoke({
        model: modelName,
        batchID: options.batchID,
        jobID: options.job.jobID,
        markID: options.batchMember.markID,
        attemptIndex,
        input,
      });

      validatedOutput = validateCompactionOutput({
        route: options.batchMember.route,
        candidate: rawOutput,
      });
    } catch (error) {
      const failure = normalizeTransportFailure(error);
      const attempt = options.store.appendCompactionJobAttempt({
        jobID: options.job.jobID,
        attemptIndex,
        modelIndex,
        modelName,
        status: "failed",
        startedAtMs: attemptStartedAtMs,
        finishedAtMs: options.now(),
        errorCode: failure.code,
        errorText: failure.detail,
        metadata: buildAttemptMetadata(failure),
      });
      attempts.push(attempt);

      if (modelIndex === options.models.length - 1) {
        return {
          job: finalizeJobFailure(options.store, options.job.jobID, failure, options.now()),
          markID: options.batchMember.markID,
          attempts,
          finalFailure: failure,
        };
      }

      continue;
    }

    if (!isJobMutable(options.store, options.job.jobID) || !isBatchMutable(options.store, options.batchID)) {
      const failure: CompactionJobFailure = {
        code: "stale-attempt-result",
        phase: "commit",
        detail:
          `Ignored late compaction result for job '${options.job.jobID}' because a newer terminal state already exists.`,
      };

      return {
        job: requireJob(options.store, options.job.jobID),
        markID: options.batchMember.markID,
        attempts,
        finalFailure: failure,
      };
    }

    const revalidation = revalidateCompactionSourceIdentity(options.store, sourceSnapshot.snapshotID);
    if (!revalidation.matches) {
      const failure = buildSourceRevalidationFailure(revalidation.failure);
      const attempt = options.store.appendCompactionJobAttempt({
        jobID: options.job.jobID,
        attemptIndex,
        modelIndex,
        modelName,
        status: "failed",
        startedAtMs: attemptStartedAtMs,
        finishedAtMs: options.now(),
        errorCode: failure.code,
        errorText: failure.detail,
      });
      attempts.push(attempt);

      return {
        job: finalizeJobFailure(options.store, options.job.jobID, failure, options.now()),
        markID: options.batchMember.markID,
        attempts,
        finalFailure: failure,
      };
    }

    const replacementID = options.ids.makeReplacementID(options.job.jobID, attemptIndex);
    const replacement = options.store.commitReplacement({
      replacementID,
      route: options.batchMember.route,
      jobID: options.job.jobID,
      committedAtMs: options.now(),
      contentText: validatedOutput.contentText,
      contentJSON: validatedOutput.contentJSON,
      metadata: validatedOutput.metadata,
      markIDs: [options.batchMember.markID],
    });

    const attempt = options.store.appendCompactionJobAttempt({
      jobID: options.job.jobID,
      attemptIndex,
      modelIndex,
      modelName,
      status: "succeeded",
      startedAtMs: attemptStartedAtMs,
      finishedAtMs: options.now(),
      replacementID,
    });
    attempts.push(attempt);

    return {
      job: finalizeJobSuccess(options.store, options.job.jobID, options.now()),
      markID: options.batchMember.markID,
      attempts,
      replacement,
    };
  }

  throw new Error(`Compaction job '${options.job.jobID}' exhausted the model chain without reaching a terminal state.`);
}

function normalizeModels(models: readonly string[]): readonly string[] {
  const normalized = models.map((model) => model.trim()).filter((model) => model.length > 0);
  if (normalized.length === 0) {
    throw new Error("Compaction runner requires at least one model in the ordered fallback chain.");
  }

  return normalized;
}

function resolveIDFactory(ids: RunCompactionBatchOptions["ids"]): CompactionRunnerIDFactory {
  return {
    makeBatchID: ids?.makeBatchID ?? DEFAULT_ID_FACTORY.makeBatchID,
    makeJobID: ids?.makeJobID ?? DEFAULT_ID_FACTORY.makeJobID,
    makeReplacementID: ids?.makeReplacementID ?? DEFAULT_ID_FACTORY.makeReplacementID,
    makeGateObservationID: ids?.makeGateObservationID ?? DEFAULT_ID_FACTORY.makeGateObservationID,
  };
}

function createObservationCounter(batchID: string, ids: CompactionRunnerIDFactory): {
  next(phase: string): string;
} {
  let ordinal = 0;

  return {
    next(phase: string) {
      const observationID = ids.makeGateObservationID(batchID, phase, ordinal);
      ordinal += 1;
      return observationID;
    },
  };
}

function finalizeBatchStatus(
  store: SqliteSessionStateStore,
  batchID: string,
  status: "succeeded" | "failed",
  metadata?: JsonValue,
): CompactionBatchRecord {
  const current = store.getCompactionBatch(batchID);
  if (current === undefined) {
    throw new Error(`Unknown compaction batch '${batchID}'.`);
  }

  if (current.status !== "frozen" && current.status !== "running") {
    return current;
  }

  return store.updateCompactionBatchStatus({
    batchID,
    status,
    metadata,
  });
}

function finalizeJobFailure(
  store: SqliteSessionStateStore,
  jobID: string,
  failure: CompactionJobFailure,
  finishedAtMs: number,
): CompactionJobRecord {
  const current = requireJob(store, jobID);
  if (current.status !== "queued" && current.status !== "running") {
    return current;
  }

  return store.updateCompactionJobStatus({
    jobID,
    status: "failed",
    finishedAtMs,
    finalErrorCode: failure.code,
    finalErrorText: failure.detail,
  });
}

function finalizeJobSuccess(
  store: SqliteSessionStateStore,
  jobID: string,
  finishedAtMs: number,
): CompactionJobRecord {
  const current = requireJob(store, jobID);
  if (current.status !== "queued" && current.status !== "running") {
    return current;
  }

  return store.updateCompactionJobStatus({
    jobID,
    status: "succeeded",
    finishedAtMs,
  });
}

function isBatchMutable(store: SqliteSessionStateStore, batchID: string): boolean {
  return store.getCompactionBatch(batchID)?.status === "running";
}

function isJobMutable(store: SqliteSessionStateStore, jobID: string): boolean {
  return store.getCompactionJob(jobID)?.status === "running";
}

function requireJob(store: SqliteSessionStateStore, jobID: string): CompactionJobRecord {
  const job = store.getCompactionJob(jobID);
  if (job === undefined) {
    throw new Error(`Unknown compaction job '${jobID}'.`);
  }

  return job;
}

function buildSourceRevalidationFailure(failure: SourceIdentityFailure): CompactionJobFailure {
  return {
    code: "source-revalidation-failed",
    phase: "commit",
    detail: failure.detail,
  };
}

function buildAttemptMetadata(failure: CompactionJobFailure): JsonValue | undefined {
  if (failure.normalizedIssues === undefined || failure.normalizedIssues.length === 0) {
    return undefined;
  }

  return {
    normalizedIssues: [...failure.normalizedIssues],
  };
}

function normalizeTransportFailure(error: unknown): CompactionJobFailure {
  if (error instanceof InvalidCompactionOutputError) {
    const failure = classifyCompactionTransportFailure({
      kind: "invocation",
      issue: "invalid-response",
    });

    return {
      code: failure.code,
      phase: failure.phase,
      detail: `${failure.detail} ${error.message}`,
      normalizedIssues: failure.normalizedIssues,
    };
  }

  if (error instanceof CompactionTransportInvocationError) {
    return toJobFailure(
      classifyCompactionTransportFailure({
        kind: "invocation",
        issue: error.issue,
      }),
      error.message,
    );
  }

  return toJobFailure(
    classifyCompactionTransportFailure({
      kind: "invocation",
      issue: "execution-error",
    }),
    describeError(error),
  );
}

function toJobFailure(
  failure: CompactionTransportFailure,
  extraDetail?: string,
): CompactionJobFailure {
  return {
    code: failure.code,
    phase: failure.phase,
    detail: extraDetail ? `${failure.detail} ${extraDetail}` : failure.detail,
    normalizedIssues: failure.normalizedIssues,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
