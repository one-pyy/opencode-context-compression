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
