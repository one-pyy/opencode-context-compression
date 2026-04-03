## send-entry-wait-must-join-live-lock-with-batch-status
Date: 2026-04-03

### Pattern / Gotcha
In this standalone DCP plugin, send-entry waiting cannot rely on the file lock alone to distinguish success, failure, and manual clear. The lock file is only the live `running` authority; once compaction finishes, the runner records terminal status in SQLite and then removes the lock file.

### Detail
Task 10 needed ordinary chat to wait at the earliest real pre-persistence seam (`chat.message`) until compaction reaches a terminal result, times out, or is manually cleared.

The first instinct was to reuse `waitForSessionFileLock()` from `src/runtime/file-lock.ts`, because that helper already models `running`, `succeeded`, `failed`, `timed-out`, and `manually-cleared` outcomes.

However, the actual production runner behavior in this repo is different from the standalone file-lock helper's richer settled-file model:

- `src/compaction/runner.ts` writes the lock file when the batch starts
- it persists terminal batch state through `store.updateCompactionBatchStatus(...)`
- in `finally`, it always calls `releaseSessionFileLock(...)`
- it does **not** call `settleSessionFileLock(...)`

That means the real runtime contract is:

- lock file present and `status=running` => compaction is actively in flight
- lock file absent + matching batch row `status=succeeded` => compaction finished successfully
- lock file absent + matching batch row `status=failed` or `cancelled` => compaction finished unsuccessfully
- lock file absent + no matching batch row, or a still-`running`/`frozen` batch row => treat as manual/operator clear or inconsistent recovery, not synthetic success

The reliable join key is the lock's `startedAtMs`, because Task 7 already aligned it with the frozen batch timestamp (`frozen_at_ms`). That makes it safe for send-entry wait code to:

1. read the live lock file while it exists
2. remember `startedAtMs`
3. when the lock disappears, resolve the matching batch by `frozen_at_ms`
4. classify terminal outcome from the persisted batch status instead of the missing file alone

This preserves the "file lock is the operator-visible live gate authority" rule without inventing a fake late-error path or misclassifying an unlocked failed batch as ordinary success.

### Applies To
- `src/runtime/send-entry-gate.ts`
- `src/compaction/runner.ts`
- `src/runtime/file-lock.ts`
- `src/marks/batch-freeze.ts`
- future send-entry or tool-gating work that needs terminal outcome after live lock removal
