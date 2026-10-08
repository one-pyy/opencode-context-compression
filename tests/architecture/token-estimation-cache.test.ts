import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTokenCountCacheKey,
  createTokenCountCache,
  TOKEN_COUNT_CACHE_MAX_ENTRIES,
} from "../../src/token-estimation-cache.js";

test("production cache holds 65536 entries and evicts least recently used counts", () => {
  assert.equal(TOKEN_COUNT_CACHE_MAX_ENTRIES, 65_536);
  const cache = createTokenCountCache();
  for (let index = 0; index < TOKEN_COUNT_CACHE_MAX_ENTRIES; index += 1) {
    cache.set(`entry-${index}`, index);
  }
  assert.equal(cache.get("entry-0"), 0);
  cache.set("entry-extra", 77);
  assert.equal(cache.get("entry-1"), undefined);
  assert.equal(cache.get("entry-0"), 0);
  assert.equal(cache.get("entry-extra"), 77);
  for (let index = 2; index < TOKEN_COUNT_CACHE_MAX_ENTRIES; index += 1) {
    assert.equal(cache.get(`entry-${index}`), index);
  }
});

test("hits and overwrites refresh recency without evicting an extra entry", () => {
  const cache = createTokenCountCache(2);
  cache.set("a", 0);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 0);
  cache.set("a", 3);
  assert.equal(cache.get("b"), 2);
  cache.set("c", 4);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("c"), 4);
});

test("fingerprints cover exact text and counting identity without retaining plaintext keys", () => {
  const input = { endpoint: "http://service.test/count", text: "正文\nbody", modelName: "model-a" };
  const base = buildTokenCountCacheKey(input);
  assert.match(base, /^[a-f0-9]{64}$/u);
  assert.equal(buildTokenCountCacheKey({ ...input }), base);
  for (const changed of [
    { ...input, text: `${input.text} ` },
    { ...input, text: input.text.replace("\n", "\r\n") },
    { ...input, modelName: "model-b" },
    { ...input, endpoint: "http://other.test/count" },
  ]) assert.notEqual(buildTokenCountCacheKey(changed), base);
  assert.notEqual(buildTokenCountCacheKey({ ...input, text: "\ud800" }), buildTokenCountCacheKey({ ...input, text: "\ud801" }));
  assert.notEqual(buildTokenCountCacheKey({ ...input, modelName: undefined }), buildTokenCountCacheKey({ ...input, modelName: "" }));
});
