import { test, expect } from "bun:test";
import { TokenCounter } from "../token-counter.js";

test("countTokens returns 0 for empty string", () => {
  const counter = new TokenCounter();
  expect(counter.countTokens("")).toBe(0);
});

test("countTokens estimates tokens correctly for short text", () => {
  const counter = new TokenCounter();
  // 4 chars = 1 token (rounded up)
  expect(counter.countTokens("test")).toBe(1);
  // 8 chars = 2 tokens
  expect(counter.countTokens("testtest")).toBe(2);
  // 5 chars = 2 tokens (rounded up)
  expect(counter.countTokens("hello")).toBe(2);
});

test("countTokens estimates tokens correctly for long text", () => {
  const counter = new TokenCounter();
  // 100 chars = 25 tokens
  const longText = "a".repeat(100);
  expect(counter.countTokens(longText)).toBe(25);
  // 1000 chars = 250 tokens
  const veryLongText = "b".repeat(1000);
  expect(counter.countTokens(veryLongText)).toBe(250);
});

test("countTokens handles single character", () => {
  const counter = new TokenCounter();
  // 1 char = 1 token (rounded up from 0.25)
  expect(counter.countTokens("a")).toBe(1);
});

test("countTokens handles whitespace", () => {
  const counter = new TokenCounter();
  // 4 spaces = 1 token
  expect(counter.countTokens("    ")).toBe(1);
  // 10 spaces = 3 tokens (rounded up from 2.5)
  expect(counter.countTokens("          ")).toBe(3);
});

test("calculateCompressionRatio returns saved tokens for normal case", () => {
  const counter = new TokenCounter();
  expect(counter.calculateCompressionRatio(100, 50)).toBe(50);
  expect(counter.calculateCompressionRatio(1000, 250)).toBe(750);
});

test("calculateCompressionRatio returns 0 when no savings", () => {
  const counter = new TokenCounter();
  expect(counter.calculateCompressionRatio(100, 100)).toBe(0);
});

test("calculateCompressionRatio returns negative when tokens increase", () => {
  const counter = new TokenCounter();
  // Edge case: compression actually increased tokens
  expect(counter.calculateCompressionRatio(50, 100)).toBe(-50);
});

test("calculateCompressionRatio handles zero tokens", () => {
  const counter = new TokenCounter();
  expect(counter.calculateCompressionRatio(0, 0)).toBe(0);
  expect(counter.calculateCompressionRatio(100, 0)).toBe(100);
  expect(counter.calculateCompressionRatio(0, 50)).toBe(-50);
});
