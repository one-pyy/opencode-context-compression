import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

interface PerformanceTrace {
  readonly stages: { name: string; elapsedMs: number }[];
  readonly tokens: {
    calls: number;
    hits: number;
    misses: number;
    requests: number;
    failures: number;
    textCharacters: number;
    hashMs: number;
  };
}

const traces = new AsyncLocalStorage<PerformanceTrace>();

export function getPerformanceTrace(): PerformanceTrace | undefined {
  return traces.getStore();
}

export function startPerformanceStage(name: string): () => void {
  const trace = traces.getStore();
  if (!trace) return () => {};
  const started = performance.now();
  return () => trace.stages.push({ name, elapsedMs: performance.now() - started });
}

export async function measurePerformanceStage<T>(
  name: string,
  action: () => Promise<T> | T,
): Promise<T> {
  const finish = startPerformanceStage(name);
  try {
    return await action();
  } finally {
    finish();
  }
}

export async function withPerformanceTrace<T>(
  emit: (payload: Record<string, unknown>) => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  if (process.env.OPENCODE_CONTEXT_COMPRESSION_PERF !== "1") return action();
  const trace: PerformanceTrace = {
    stages: [],
    tokens: { calls: 0, hits: 0, misses: 0, requests: 0, failures: 0, textCharacters: 0, hashMs: 0 },
  };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  return traces.run(trace, async () => {
    let succeeded = false;
    try {
      const result = await action();
      succeeded = true;
      return result;
    } finally {
      const payload = {
        startedAt,
        elapsedMs: performance.now() - started,
        succeeded,
        rssBefore,
        rssAfter: process.memoryUsage().rss,
        stages: trace.stages.slice(),
        tokens: { ...trace.tokens },
      };
      try {
        await emit(payload);
      } catch {
        // Diagnostic failure must not change a model request's outcome.
      }
    }
  });
}
