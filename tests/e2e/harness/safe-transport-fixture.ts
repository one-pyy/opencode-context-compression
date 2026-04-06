export interface SafeTransport<Request, Response> {
  invoke(request: Request): Promise<Response>;
}

export interface ScriptedSafeTransportCall<Request> {
  readonly callIndex: number;
  readonly stepKind: ScriptedSafeTransportStep<Request, unknown>["kind"];
  readonly request: Request;
}

export type ScriptedSafeTransportStep<Request, Response> =
  | {
      readonly kind: "success";
      readonly result: Response;
      readonly assertRequest?: (request: Request, callIndex: number) => void;
    }
  | {
      readonly kind: "failure";
      readonly message: string;
      readonly assertRequest?: (request: Request, callIndex: number) => void;
    }
  | {
      readonly kind: "timeout";
      readonly timeoutMs: number;
      readonly assertRequest?: (request: Request, callIndex: number) => void;
    };

export interface ScriptedSafeTransportFixture<Request, Response> {
  readonly transport: SafeTransport<Request, Response>;
  readonly calls: ScriptedSafeTransportCall<Request>[];
  remainingSteps(): number;
  assertConsumed(): void;
}

export class SafeTransportFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeTransportFailureError";
  }
}

export class SafeTransportTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Safe transport fixture produced a deterministic timeout after ${timeoutMs}ms.`,
    );
    this.name = "SafeTransportTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class SafeTransportScriptExhaustedError extends Error {
  constructor() {
    super(
      "Safe transport fixture script was exhausted. Add another scripted step for this invocation.",
    );
    this.name = "SafeTransportScriptExhaustedError";
  }
}

export function createScriptedSafeTransportFixture<Request, Response>(
  steps: readonly ScriptedSafeTransportStep<Request, Response>[],
): ScriptedSafeTransportFixture<Request, Response> {
  const calls: ScriptedSafeTransportCall<Request>[] = [];
  let nextStepIndex = 0;

  return {
    transport: {
      async invoke(request) {
        const step = steps[nextStepIndex];
        if (step === undefined) {
          throw new SafeTransportScriptExhaustedError();
        }

        step.assertRequest?.(request, nextStepIndex);
        calls.push({
          callIndex: nextStepIndex,
          stepKind: step.kind,
          request: cloneForCallLog(request),
        });
        nextStepIndex += 1;

        switch (step.kind) {
          case "success":
            return cloneForCallLog(step.result) as Response;
          case "failure":
            throw new SafeTransportFailureError(step.message);
          case "timeout":
            throw new SafeTransportTimeoutError(step.timeoutMs);
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
          `Safe transport fixture still has ${steps.length - nextStepIndex} unconsumed scripted step(s).`,
        );
      }
    },
  } satisfies ScriptedSafeTransportFixture<Request, Response>;
}

export function injectSafeTransport<T extends object, Request, Response>(
  target: T,
  fixture: Pick<ScriptedSafeTransportFixture<Request, Response>, "transport">,
): T & { transport: SafeTransport<Request, Response> } {
  return {
    ...target,
    transport: fixture.transport,
  };
}

function cloneForCallLog<T>(value: T): T {
  return structuredClone(value);
}
