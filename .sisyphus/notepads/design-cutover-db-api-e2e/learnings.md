# 2026-04-06 runtime-config / prompt contract
- `src/config/runtime-config.ts` is now the repo-owned entry point for runtime config loading. Later DB/runtime/interface work should call it instead of re-reading `runtime-config.jsonc` or prompt files ad hoc.
- Override order is explicit and DESIGN-aligned: canonical repo config file first, then field-level env overrides. Blank env values are treated as configuration errors, not as silent "unset" fallbacks.
- Reminder prompt assets are validated as plain text only: missing files, empty files, and `{{placeholder}}`-style template remnants fail fast.
- Path resolution is unified around repo-root-relative or absolute strings so later runtime components can consume resolved file paths directly without duplicating path normalization.
- `src/state/sidecar-store.ts` is now the DESIGN-aligned minimum sidecar boundary: only `schema_meta`, `visible_sequence_allocations`, `result_groups`, and `result_fragments` are allowed to survive bootstrap.
- Fresh bootstrap creates only `state/<session-id>.db`; lock files, seam logs, runtime logs, and debug snapshots are resolved as separate repo-owned artifacts and are not materialized by DB bootstrap.
- Replay rebuild after DB removal is safe because visible-id allocations are deterministic from canonical ids and committed replacement groups are treated as cache-like sidecar state, while restart recovery still comes from `locks/<session-id>.lock` instead of SQLite job/gate tables.
- Legacy truth tables or incompatible schema remnants such as `marks`, `source_snapshots`, `canonical_sources`, gate/job audit tables, or old `fragment_kind` layouts are cut over destructively rather than preserved for compatibility.
## 2026-04-06 hermetic e2e harness foundation
- The active repo had no live tests tree; old E2E examples only existed under .rubbish/tests/**, so the new harness had to be built cleanly under tests/e2e/harness/** instead of preserving legacy layout.
- For Node test runner compatibility, hermetic network deny is safest as a process-level guard that patches fetch, node:http, and node:https, and harness tests should run with { concurrency: false } so one test owns the deny hook at a time.
- Standardized evidence output now lives under .sisyphus/evidence/task-3-hermetic-e2e/<session-id>/ with a manifest plus named JSON/text artifacts, which gives later E2E tasks a stable place to dump proof artifacts.
- Repo-wide npm run typecheck currently fails because of pre-existing row-generic typing errors in src/state/sidecar-store.ts; the new harness files themselves passed LSP diagnostics and the three required Node harness tests passed.
- Task 1 had to be narrowed back after overreaching into Task 2: the sidecar module now stops at locked-schema bootstrap, destructive legacy reset, and replay-driven rebuild hydration, without exposing repository-style read/write APIs.
- The plan’s locked SQL naming won over the earlier convenience schema: `schema_meta(key,value)` and the full `visible_sequence_allocations(canonical_id, visible_seq, visible_kind, visible_base62, assigned_visible_id, allocated_at)` shape are now the enforced Task 1 baseline.

## 2026-04-06 Task 2 repository semantics
- `src/state/sidecar-store.ts` now exposes the first real sidecar repository contract on top of the locked Task-1 schema: visible-id `allocate/read/list` plus committed result-group `create/read/list/by-mark-id/idempotent upsert`.
- `allocateVisibleID` uses its own `BEGIN IMMEDIATE` transaction and returns the pre-existing allocation unchanged when the same canonical id is requested again with the same `visibleKind`; a kind mismatch for the same canonical id is treated as a durable conflict instead of silently reallocating.
- Result-group persistence remains all-or-nothing per `mark_id`: the `result_groups` row and every `result_fragments` row are inserted in one transaction, and any mid-write failure leaves both tables with zero visible rows for that mark id.
- Idempotent result-group upsert is content-stable, not last-write-wins: replaying the same committed payload returns `unchanged`, while reusing a committed `mark_id` with different durable content fails fast.
- Read-model completeness is strict at repository read time: if `fragment_count` does not match the number of persisted fragments, or fragment indexes are not contiguous from `0`, the repository throws a corruption error instead of returning a partial replacement.

## 2026-04-06 Task 5 safe transport contract
- The compaction seam now has a repo-owned injected contract under `src/compaction/transport/`: request building, payload validation, typed timeout/retryable/fatal/abort errors, and scripted call recording all live there so later scheduler/runner work can stay hermetic without importing test-only helpers.
- The request builder intentionally carries `promptText`, `executionMode`, `allowDelete`, `timeoutMs`, and a numbered transcript slice; this mirrors `prompts/compaction.md` and makes malformed payload or retry logic assert against the exact compaction request that was sent.
- Missing transport is treated as a deterministic configuration error in `src/runtime/compaction-transport.ts`, and `createCompactionRunner` refuses to expose any fallback live executor path.
- Call recording stores a clone of the request plus a normalized outcome union (`success`, `retryable-error`, `fatal-error`, `timeout`, `aborted`), which gives later E2E and recovery tasks stable assertion material without coupling to provider SDK error shapes.
- Caller-driven aborts do not consume scripted transport steps, while transport-origin cancellation is recorded as a distinct aborted outcome; that split keeps cancellation semantics explicit for later lock/scheduler recovery tests.

## 2026-04-06 Task 6 external plugin seams
- The plugin surface is now locked to four external seams only: `experimental.chat.messages.transform`, `chat.params`, `tool.execute.before`, and the `compression_mark` tool. `chat.message` was removed from the entry wiring so later runtime work cannot quietly treat it as part of the public contract.
- `compression_mark` now has an explicit repo-owned contract module that validates only one target object with `target.startVisibleMessageID` / `target.endVisibleMessageID`; legacy `range` shapes and batch targets fail as `INVALID_RANGE` before any admission logic runs.
- Keeping `index.ts` as pure wiring works well with the current cutover skeleton: seam logging stays in the hook factory, while tool validation/admission and chat/tool hook behavior live in dedicated modules that later tasks can replace without growing the plugin entry into a monolith.
- `chat.params` is easiest to keep narrow by writing one namespaced metadata object under `output.options` and asserting the absence of transcript/projection keys in contract tests; this prevents the seam from slowly absorbing rendering responsibilities.

## 2026-04-06 Task 7 internal module contracts
- The cleanest Task 7 shape was to put each contract on its natural seam file or concern directory (`src/runtime/`, `src/history/`, `src/state/`, `src/identity/`, `src/projection/`, `src/compaction/`) and keep only one tiny shared helper in `src/internal/module-contract.ts`; this avoids the giant-index / giant-types trap while still making the graph testable.
- `ResultGroupRepository` stays intentionally narrow on top of the Task 2 sidecar surface: complete result-group upsert/read/list-overlap plus visible-id allocate/read only. Task 7 does not introduce replay checkpoints, job repositories, or gate persistence APIs.
- The projection and compaction modules can be contract-composable without overreaching into Tasks 8-10 by using explicit dependency descriptors plus minimal callback/static builders; interface tests then lock the dependency direction and forbid circular imports before the real runtime semantics land.
- Reusing the existing runtime-config loader, reminder prompt resolver, sidecar repository, and safe transport seams was enough to give the new contracts real compile-time anchors; no parallel abstraction layer was needed.

## 2026-04-06 Task 8 replay / projection behavior
- The most stable Task 8 flow is: classify canonical host messages first, allocate durable host visible IDs from those classifications, then replay `compression_mark` inputs against the allocated visible IDs to resolve mark ranges into source-sequence intervals. Reversing that order makes replay depend on guessed IDs instead of the sidecar mapping.
- Coverage-tree legality is simplest when replay insertion enforces one rule at every sibling level: disjoint ranges stay siblings, strict containment recurses, and equal-or-containing later marks adopt earlier covered nodes as children. Partial overlap without containment becomes an immediate replay conflict and never enters the mark tree.
- Result-group fallback works cleanly when rendering treats every complete group as an in-place fragment replacement over the original source span rather than a whole-range monolith. That lets parent-missing / child-present cases naturally produce child replacements plus original gaps without leaking partial parent state.
- Reminder cleanup becomes automatic once reminder computation runs on the already-projected visible message list instead of raw history. Successful replacements remove the covered canonical messages from the visible list, so any reminder that used to anchor inside that window disappears without touching durable host history.
- Hermetic Task 8 interface tests need to remove the per-session SQLite file before bootstrapping because the harness uses deterministic session IDs per case name; otherwise rerunning a test locally can accidentally reuse old result groups and hide projection regressions.

## 2026-04-06 Task 9 compaction runner behavior
- Compact-mode placeholder validation is safest when the builder emits a deterministic repo-owned placeholder form (`<opaque slot="S1">...</opaque>`) and the validator requires those exact opaque blocks to survive in output order. That makes `P_in ⊆ P_out` executable instead of hand-wavy.
- Preserving pre-existing projection state is easiest if the runner treats malformed payloads, invalid compact output, and retryable transport errors as recoverable-before-commit failures: no repository write happens until one validated attempt succeeds, so timeout/malformed/invalid cases leave zero partial rows for the new mark while existing groups remain untouched.
- A successful compact output that keeps opaque placeholders can be committed without leaking literal placeholder XML into projection by splitting the winning text into fragments around the preserved opaque blocks and only persisting the compressible windows. The existing projection renderer already knows how to fill the opaque gaps from history/result-group fallback.
- Task 9 fits cleanly on top of the Task 5 safe transport seam and Task 2 repository atomics; no extra job-state or gate-state persistence is needed to prove retry order, model fallback, or failure-state preservation.

## 2026-04-06 Task 10 runtime gate / scheduler behavior
- `SendEntryGate` is now correctly a thin adapter over `src/runtime/file-lock.ts`: ordinary-chat wait exits are driven by the real lock outcomes (`running` -> wait, then `succeeded` / `failed` / manual clear / stale timeout) instead of a parallel gate-specific state machine.
- The real `chat.params` path can stay narrow while still being replay-backed: it reads host session history just far enough to reconstruct replayable `compression_mark` intents, compute currently eligible mark IDs, and emit small runtime metadata under `output.options`, without rendering messages or owning ordinary-chat waiting.
- Batch-freeze semantics are naturally testable without new persistence by freezing `eligibleMarkIds` at dispatch time and then refusing to redispatch while a live lock is running; marks replayed during that lock remain visible as queued metadata for the next batch instead of being pulled into the active one.
- The host session API only exposes `user` / `assistant` message infos, with `compression_mark` replay coming from assistant `tool` parts. Task 10 runtime tests should therefore build replay fixtures from assistant tool parts rather than assuming standalone host `tool` messages exist in session history.

## 2026-04-06 Task 10 verification follow-up
- `src/index.ts` thinness is enforced by the interface suite, not just by style preference. When runtime behavior grows, move assembly into a dedicated runtime wiring helper rather than letting the plugin entry absorb host-client reads or gate construction details.
- Transport call-recording tests should track the full current request contract. Once compaction transcript entries gain stable fields like source sequence bounds or optional placeholder metadata, the hermetic assertions should explicitly include them instead of silently pinning an outdated subset.

## 2026-04-06 Task 11 recovery / delete admission behavior
- The strongest anti-fake-green check for recovery paths is to assert all three surfaces together: the runner error/outcome, the sidecar row counts for the candidate `mark_id`, and the replayed projection text. Timeout and malformed payload cases now prove all three stay unchanged until a validated success commits.
- Restart recovery stays faithful to the DESIGN cutover when the runtime only trusts host history plus committed sidecar result groups. An in-flight parent mark with only a file lock and no committed group cleanly replays to child-result fallback plus original gaps after reopening the sidecar; no checkpoint/job table is needed.
- Stale-lock recovery is real runtime behavior, not an operator-only note: `waitForSessionFileLock()` already gives the two required exits (`timed-out` for stale running locks and `manually-cleared` after unlink), so recovery E2E should exercise those file-lock semantics directly instead of inventing extra runtime persistence.

## 2026-04-06 Task 11 follow-up stability fix
- Recovery tests should not open a second raw SQLite connection just to count `result_groups` / `result_fragments` while a session sidecar repository is already open. On some verifiers that pattern can surface as `disk I/O error` or `database is locked`; repository-backed committed-group checks prove the same “no partial visible result” invariant without cross-handle contention.
- For Task 11 full-suite stability, keeping the session ID deterministic was not the problem; sharing the repo `state/` directory was. Using a per-test temporary plugin root for recovery suites preserves stable session semantics while isolating the actual SQLite file path that full-suite workers contend on.

## 2026-04-06 Task 12 full success path
- The anti-fake-green shape for Task 12 is to derive compaction input from replayed projection state itself, not to hand-author a transcript in the happy-path E2E. `src/compaction/replay-run-input.ts` now turns a replayed legal mark node back into the frozen compaction transcript, so the test proves the real `compression_mark -> replay -> compaction input -> validated commit -> projection update` chain instead of a parallel shortcut.
- The default plugin wiring now attaches a real sidecar-backed `messages.transform` projector through `src/runtime/default-messages-transform.ts`, while `chat.params` stays narrow and file-lock-backed gate behavior stays separate. This keeps `index.ts` thin and preserves the DESIGN boundary that prompt projection belongs only to `messages.transform`.

## 2026-04-06 Final Wave blocker follow-up
- The shipped runtime replay adapter must treat top-level host `tool` messages as canonical history, not as helper-only test data. Filtering them out in `src/runtime/session-history.ts` silently breaks projection/token semantics while leaving narrower unit-style coverage green.
- Delete admission needed a real runtime/config policy path in the default plugin wiring. A small repo-owned `allowDelete` runtime-config flag was enough to restore DESIGN-aligned blocked/allowed behavior without widening `chat.params`, changing projection ownership, or adding new persistence.
