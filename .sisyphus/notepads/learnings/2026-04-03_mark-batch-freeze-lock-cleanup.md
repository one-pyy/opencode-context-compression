## mark-batch-freeze-lock-cleanup
Date: 2026-04-03

### Pattern / Gotcha
If compaction batch dispatch acquires the session file lock before the frozen batch is durably written to SQLite, any later persistence error must release that lock immediately.

### Detail
Task 7 introduced a thin `src/marks/batch-freeze.ts` orchestration layer that first calls the existing runtime primitive `startFrozenCompactionBatch()` and then persists the frozen membership with `store.createCompactionBatch()`.

That ordering is useful because it preserves the Task 4 invariant that batch membership is frozen at dispatch time and the file lock's `startedAtMs` matches the frozen batch timestamp. But it creates a cross-layer failure mode:

- the runtime lock may already exist on disk
- the SQLite batch row and `compaction_batch_marks` rows may not yet exist
- if `createCompactionBatch()` throws, ordinary chat would still observe an active `compressing` gate even though no durable batch was created

The safe behavior is to clear the lock in the catch path before rethrowing. This keeps the file-backed gate authoritative without letting it represent a phantom batch.

This is especially important for later runner work, because future code may add more batch-persistence steps after lock acquisition. Any failure after the lock is acquired but before the batch is durably reviewable should either:

- release the lock, or
- finish writing a consistent batch state that downstream code can inspect and settle

Do not leave the lock behind for a batch that never became durable.

### Applies To
- `src/marks/batch-freeze.ts`
- Future compaction runner code that acquires the session lock before persisting batch/job state
- Any send-entry gating logic that trusts the file lock as the operator-visible authority
