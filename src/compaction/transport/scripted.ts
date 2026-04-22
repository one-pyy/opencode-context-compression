import {
  CompactionTransportAbortedError,
  CompactionTransportFatalError,
  CompactionTransportRetryableError,
  CompactionTransportScriptExhaustedError,
  CompactionTransportTimeoutError,
} from "./errors.js";
import type {
  CompactionTransport,
  CompactionTransportRequest,
  RecordedCompactionTransportCall,
  RecordedCompactionTransportCallOutcome,
  RecordedCompactionTransportRequest,
} from "./types.js";

export type ScriptedCompactionTransportStep =
  | {
      readonly kind: "success";
      readonly rawPayload: unknown;
      readonly assertRequest?: (
        request: CompactionTransportRequest,
        callIndex: number,
      ) => void;
    }
  | {
      readonly kind: "retryable-error";
      readonly message: string;
      readonly code?: string;
      readonly assertRequest?: (
        request: CompactionTransportRequest,
        callIndex: number,
      ) => void;
    }
  | {
      readonly kind: "fatal-error";
      readonly message: string;
      readonly assertRequest?: (
        request: CompactionTransportRequest,
        callIndex: number,
      ) => void;
    }
  | {
      readonly kind: "timeout";
      readonly timeoutMs: number;
      readonly assertRequest?: (
        request: CompactionTransportRequest,
        callIndex: number,
      ) => void;
    }
  | {
      readonly kind: "cancelled";
      readonly reason?: string;
      readonly assertRequest?: (
        request: CompactionTransportRequest,
        callIndex: number,
      ) => void;
    };

export interface ScriptedCompactionTransport {
  readonly transport: CompactionTransport;
  readonly calls: readonly RecordedCompactionTransportCall[];
  remainingSteps(): number;
  assertConsumed(): void;
}

export function createScriptedCompactionTransport(
  steps: readonly ScriptedCompactionTransportStep[],
): ScriptedCompactionTransport {
  const calls: RecordedCompactionTransportCall[] = [];
  let nextStepIndex = 0;

  return {
    transport: {
      async invoke(request) {
        const callIndex = calls.length;
        const recordedRequest = cloneRequestForRecording(request);

        if (request.signal?.aborted) {
          const aborted = new CompactionTransportAbortedError({
            origin: "caller",
            reason: formatAbortReason(request.signal.reason),
          });
          calls.push({
            callIndex,
            request: recordedRequest,
            outcome: {
              kind: "aborted",
              origin: "caller",
              reason: aborted.reason,
            },
          });
          throw aborted;
        }

        const step = steps[nextStepIndex];
        if (step === undefined) {
          throw new CompactionTransportScriptExhaustedError();
        }

        step.assertRequest?.(request, callIndex);
        nextStepIndex += 1;

        switch (step.kind) {
          case "success": {
            const rawPayload = structuredClone(step.rawPayload);
            recordCall(calls, callIndex, recordedRequest, {
              kind: "success",
              rawPayload,
            });
            return rawPayload;
          }
          case "retryable-error": {
            recordCall(calls, callIndex, recordedRequest, {
              kind: "retryable-error",
              message: step.message,
              code: step.code,
            });
            throw new CompactionTransportRetryableError(step.message, {
              code: step.code,
            });
          }
          case "fatal-error": {
            recordCall(calls, callIndex, recordedRequest, {
              kind: "fatal-error",
              message: step.message,
            });
            throw new CompactionTransportFatalError(step.message);
          }
          case "timeout": {
            recordCall(calls, callIndex, recordedRequest, {
              kind: "timeout",
              timeoutMs: step.timeoutMs,
            });
            throw new CompactionTransportTimeoutError(step.timeoutMs);
          }
          case "cancelled": {
            recordCall(calls, callIndex, recordedRequest, {
              kind: "aborted",
              origin: "transport",
              reason: step.reason,
            });
            throw new CompactionTransportAbortedError({
              origin: "transport",
              reason: step.reason,
            });
          }
        }
      },
    },
    calls,
    remainingSteps() {
      return steps.length - nextStepIndex;
    },
    assertConsumed() {
      if (nextStepIndex !== steps.length) {
        throw new Error(
          `Scripted compaction transport still has ${steps.length - nextStepIndex} unconsumed step(s).`,
        );
      }
    },
  } satisfies ScriptedCompactionTransport;
}

function cloneRequestForRecording(
  request: CompactionTransportRequest,
): RecordedCompactionTransportRequest {
  return {
    sessionID: request.sessionID,
    markID: request.markID,
    model: request.model,
    executionMode: request.executionMode,
    promptText: request.promptText,
    transcript: structuredClone(request.transcript),
    timeoutMs: request.timeoutMs,
    firstTokenTimeoutMs: request.firstTokenTimeoutMs,
    streamIdleTimeoutMs: request.streamIdleTimeoutMs,
    signalState:
      request.signal === undefined
        ? "missing"
        : request.signal.aborted
          ? "aborted"
          : "active",
  } satisfies RecordedCompactionTransportRequest;
}

function recordCall(
  calls: RecordedCompactionTransportCall[],
  callIndex: number,
  request: RecordedCompactionTransportRequest,
  outcome: RecordedCompactionTransportCallOutcome,
): void {
  calls.push({
    callIndex,
    request,
    outcome,
  });
}

function formatAbortReason(reason: unknown): string | undefined {
  if (typeof reason === "string") {
    return reason;
  }

  if (reason instanceof Error) {
    return reason.message;
  }

  if (reason === undefined) {
    return undefined;
  }

  return String(reason);
}
