import assert from "node:assert/strict";
import test from "node:test";

import { createContractLevelCompactionRunnerImplementation, computeCompactionAttempt, commitCompactionAttempt } from "../../src/compaction/runner/internal-runner.js";
import type { InternalCompactionRunnerDependencies } from "../../src/compaction/runner.js";
import type { RunCompactionInput } from "../../src/compaction/types.js";
import type { CompactionInputBuilder } from "../../src/compaction/input-builder.js";
import type { OutputValidator } from "../../src/compaction/output-validation.js";
import type { SafeTransportAdapter } from "../../src/runtime/compaction-transport.js";
import type { ResultGroupRepository } from "../../src/state/result-group-repository.js";

test("compaction compute can run independently and commit remains ordered", async () => {
  const events: string[] = [];
  const releaseFirst = deferred<void>();
  const releaseSecond = deferred<void>();

  const dependencies: InternalCompactionRunnerDependencies = {
    inputBuilder: {
      async build(input) {
        return {
          sessionID: input.sessionId,
          markID: input.markId,
          model: input.model,
          executionMode: "compact",
          promptText: input.promptText,
          transcript: [],
          timeoutMs: input.timeoutMs,
        };
      },
    } as CompactionInputBuilder,
    transport: {
      async execute(request) {
        events.push(`transport:${request.markID}`);
        if (request.markID === "mark-1") {
          await releaseFirst.promise;
        } else {
          await releaseSecond.promise;
        }
        return { rawPayload: { ok: true } };
      },
    } as SafeTransportAdapter,
    outputValidator: {
      async validate({ request }) {
        return { contentText: `ok:${request.markID}` };
      },
    } as OutputValidator,
    resultGroupRepository: {
      async upsertCompleteGroup(input) {
        events.push(`commit:${input.markId}`);
      },
      async getCompleteGroup() {
        return null;
      },
      async listGroupsOverlappingRange() {
        return [];
      },
      async allocateVisibleId() {
        throw new Error("unused");
      },
      async listPendingMarkIds() {
        return [];
      },
    } as ResultGroupRepository,
  };

  const input1 = createRunInput("mark-1");
  const input2 = createRunInput("mark-2");

  const compute1 = computeCompactionAttempt(dependencies, input1);
  const compute2 = computeCompactionAttempt(dependencies, input2);

  await tick();
  assert.deepEqual(events, ["transport:mark-1", "transport:mark-2"]);

  releaseSecond.resolve();
  const computed2 = await compute2;
  await commitCompactionAttempt(
    { computation: computed2, runInput: input2 },
    dependencies,
  );
  assert.deepEqual(events.slice(-1), ["commit:mark-2"]);

  releaseFirst.resolve();
  const computed1 = await compute1;
  await commitCompactionAttempt(
    { computation: computed1, runInput: input1 },
    dependencies,
  );

  assert.deepEqual(events, [
    "transport:mark-1",
    "transport:mark-2",
    "commit:mark-2",
    "commit:mark-1",
  ]);
});

function createRunInput(markId: string): RunCompactionInput {
  return {
    build: {
      sessionId: "session-1",
      markId,
      model: "model-a",
      executionMode: "compact",
      promptText: "compress",
      transcript: [],
      timeoutMs: 1_000,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
