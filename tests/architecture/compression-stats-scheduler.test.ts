import assert from "node:assert/strict";
import test from "node:test";
import { createCompressionStatsScheduler, type CompressionStatsSnapshot } from "../../src/runtime/compression-stats.js";
import type { ProjectedMessageSet } from "../../src/projection/types.js";

function projection(marker: string): ProjectedMessageSet {
  return { sessionId: "same-session", marker } as unknown as ProjectedMessageSet;
}

function snapshot(sessionID: string): CompressionStatsSnapshot {
  return { sessionID, protectedTokenCount: 0, deletableTokenCount: 0, compressibleTokenCount: 0, reasoningTokenCount: 0, updatedAt: "now" };
}

test("stats scheduler coalesces pending projections and publishes only the latest", async () => {
  let releaseFirst!: () => void;
  const firstCompute = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const computed: string[] = [];
  const written: string[] = [];
  const published: string[] = [];
  const scheduler = createCompressionStatsScheduler({
    compute: async (value) => {
      const marker = (value as ProjectedMessageSet & { marker: string }).marker;
      computed.push(marker);
      if (computed.length === 1) await firstCompute;
      return snapshot(marker);
    },
    write: async (stats) => { written.push(stats.sessionID); },
    onPublished: async (stats) => { published.push(stats.sessionID); },
  });

  scheduler(projection("first"));
  scheduler(projection("second"));
  scheduler(projection("latest"));
  await Promise.resolve();
  assert.deepEqual(computed, ["first"]);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(computed, ["first", "latest"]);
  assert.deepEqual(written, ["latest"]);
  assert.deepEqual(published, ["latest"]);
});

test("stats scheduler skips reminders superseded while writing and serializes delivery", async () => {
  let releaseWrite!: () => void;
  const writing = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let releaseDelivery!: () => void;
  const delivering = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  const published: string[] = [];
  const scheduler = createCompressionStatsScheduler({
    compute: async (value) => snapshot((value as ProjectedMessageSet & { marker: string }).marker),
    write: async (stats) => { if (stats.sessionID === "first") await writing; },
    onPublished: async (stats) => {
      published.push(stats.sessionID);
      if (stats.sessionID === "second") await delivering;
    },
  });
  scheduler(projection("first"));
  await new Promise((resolve) => setImmediate(resolve));
  scheduler(projection("second"));
  releaseWrite();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, ["second"]);
  scheduler(projection("third"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, ["second"]);
  releaseDelivery();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published, ["second", "third"]);
});

test("stats scheduler isolates sessions and contains failures", async () => {
  const written: string[] = [];
  const errors: unknown[] = [];
  const scheduler = createCompressionStatsScheduler({
    compute: async (value) => {
      const marker = (value as ProjectedMessageSet & { marker: string }).marker;
      if (marker === "broken") throw new Error("stats failed");
      return snapshot(marker);
    },
    write: async (stats) => { written.push(stats.sessionID); },
    onError: (error) => { errors.push(error); },
  });
  scheduler(projection("broken"));
  scheduler(projection("healthy"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ["healthy"]);
  assert.equal(errors.length, 1);
});
