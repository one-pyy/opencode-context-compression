import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildStableVisibleId } from "../../src/identity/visible-sequence.js";

// DESIGN.md 5.1 & 5.2: 
// 前六位：永久递增序号（000001, 000002, ...）
// 后缀：2位 base62 校验码
// 格式示例: compressible_000001_q7
test("DESIGN.md Contract 5.2 - Visible ID Format MUST use 2-character base62 suffix", () => {
  const visibleId = buildStableVisibleId("compressible", 1, "msg_test_123");
  
  // Regex strictly enforces: [kind]_[6 digits]_[exactly 2 alphanumeric chars]
  const designRegex = /^[a-z]+_\d{6}_[a-zA-Z0-9]{2}$/;
  
  assert.match(
    visibleId, 
    designRegex, 
    `Implementation violates DESIGN.md 5.2: Expected format like 'compressible_000001_q7', but got '${visibleId}'`
  );
});

