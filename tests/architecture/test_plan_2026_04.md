# Automated Test Plan for opencode-context-compression (2026-04 Architecture)

This document defines the deterministic, data-driven test architecture for the compression plugin, replacing manual runbooks for complex algorithmic behaviors (Section 15 of DESIGN.md).

## 1. Core Principles
- **No LLM in Core Logic Tests**: The `messages.transform` hook is a pure projection function. It must be tested deterministically using a Mock Store and seeded histories.
- **Token Simulation (`chars / 4`)**: All token counting in tests will use the hardcoded `chars / 4` logic currently active in the implementation. A placeholder for a `tiktoken` strategy remains if the environment supports it later.
- **Schema-Aligned Fixtures**: Test inputs must perfectly mirror the `info.id` and envelope structures captured from live OpenCode debug snapshots.

## 2. Test Phases & Strategy

### Phase 1: Pure Logic & Coverage Tree Tests (Mock Store)
These tests validate the heavy algorithmic lifting defined in DESIGN.md Section 15. They run instantly using seeded arrays and an in-memory Mock Store.

*   **Test 1.1: Basic Compact (15.28)**
    *   *Input*: History `[U1, A1, T1, U2]`. Mark `m1` over `[A1~T1]`. DB has complete `result_group` for `m1`.
    *   *Assert*: Output is `[U1, Replacement(m1), U2]`.
*   **Test 1.2: Big Covers Small - Big Pending (15.29)**
    *   *Input*: Mark `m_small` over `[A1~T1]`, Mark `m_big` over `[U1~U2]`. DB has `m_small` but NOT `m_big`.
    *   *Assert*: Output falls back to `m_small`. `m_big` is silently queued.
*   **Test 1.3: Big Covers Small - Big Ready (15.30)**
    *   *Input*: Same as 1.2, but DB has complete results for BOTH.
    *   *Assert*: Output shows ONLY `Replacement(m_big)`. `m_small` is swallowed.
*   **Test 1.4: Intersection Rejection (15.32)**
    *   *Input*: Mark 1 `[A1~T2]`, Mark 2 `[T1~U2]`.
    *   *Assert*: Mark 2 is rejected. Its tool call is rendered as a visible error message. Mark 1 proceeds normally.
*   **Test 1.5: Incompressible Fragments & Gap Merging (15.18 & 15.33)**
    *   *Input*: Mark over `[U1, C1, U2]` where `C1` is an existing compact block. DB has 2 fragments for the new mark.
    *   *Assert*: Output correctly interleaves `Fragment 0`, `C1`, `Fragment 1`.

### Phase 2: Threshold & Token Lifecycle Tests
These tests validate the `chars / 4` gating logic and Reminder insertions.

*   **Test 2.1: Small User Message Protection**
    *   *Input*: User message with length < `smallUserMessageThreshold`.
    *   *Assert*: Classified as `protected`. Contributes 0 to reminder token count.
*   **Test 2.2: Soft/Hard Reminder Cadence**
    *   *Input*: Generate string of exact length `(hsoft * 4) - 4`. Assert no reminder.
    *   *Input*: Add 4 chars. Assert `soft` reminder appears.
    *   *Input*: Generate string reaching `hhard * 4`. Assert `hard` reminder replaces `soft`.

### Phase 3: Admission & Delete Route Tests
*   **Test 3.1: Delete Admission Gate**
    *   *Config*: `allowDelete = false`.
    *   *Input*: Tool call requests `mode=delete`.
    *   *Assert*: Hook treats it as an error tool call (no mark created).
*   **Test 3.2: Delete Rendering**
    *   *Config*: `allowDelete = true`.
    *   *Input*: Tool call requests `mode=delete`. DB has delete-style result.
    *   *Assert*: Output strips source completely, leaving only minimal delete notice.

### Phase 4: Live Prompt & LLM Output Quality E2E (Gemini-3-Flash)
Unlike Phases 1-3, this test actually hits a real LLM. Its sole purpose is to verify that the `prompts/compaction.md` system prompt effectively coerces the model into outputting the correct format (especially regarding XML placeholders).
*   *Setup*: Use `gemini-3-flash` as the execution model.
*   *Input*: A complex source text with injected `<opaque slot="S1">` tags.
*   *Assert*: The LLM's raw output successfully includes the `S1` placeholder without modifying its internal contents. Success rate is tracked.