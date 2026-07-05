## legacy-sidecar-table-must-not-trigger-destructive-reset
Date: 2026-07-05

### Symptom

A previously restored session sidecar regressed from 31 applied result groups to 1 result group. Projection stopped replacing most marked ranges, and the session returned to a very large prompt-visible token count.

### Trigger Conditions

The backup sidecar DB contained an old `pending_compactions` table. Current schema bootstrap treated any user schema object outside the current whitelist as incompatible and dropped every user table before recreating the schema. That erased `result_groups`, `result_fragments`, and `visible_sequence_allocations`.

This can happen whenever a long-lived sidecar DB outlives a schema simplification and runtime bootstrap uses destructive compatibility checks instead of explicit migrations.

### Resolution

Schema bootstrap must be incremental and data-preserving:

- create missing current tables with `CREATE TABLE IF NOT EXISTS`
- add known compatible columns with explicit `ALTER TABLE`
- clean known legacy tables such as `pending_compactions` as single-table cleanup only
- preserve committed result data in `result_groups`, `result_fragments`, and `visible_sequence_allocations`
- fail on missing required columns in critical current tables instead of silently dropping data

The concrete fix replaced the destructive all-object reset in `opencode-context-compression/src/state/sidecar-store/schema.ts` with known legacy table cleanup plus required-column validation. The regression test is `opencode-context-compression/tests/e2e/database/sidecar-schema-migration.test.ts`.

### Additional Observations

**2026-07-05**: After restoring `ses_0f63f8c07ffe4t9s1JPGFGaPd8` from `.bak/db-20260704-002640`, result data was present but projection still leaked original text because `result_fragments.source_start_seq/source_end_seq` used an old replay sequence coordinate. The preserved `logs/compaction-records/*.in.yaml` files contained `hostMessageID` transcript entries for all 31 `result_groups.mark_id` values, so `scripts/repair-result-group-sequences.ts --hook-in logs/debug-snapshots/ses_0f63f8c07ffe4t9s1JPGFGaPd8.projection-in.json --apply` repaired all 31 groups with `skippedCount=0`. Projection then dropped from about 166k tokens to about 56.5k tokens; remaining compressible tokens were outside the repaired result group span, not evidence of the same fragment-range leak.

**2026-07-05**: For sessions without preserved `compaction-records/*.in.yaml`, the old sequence coordinate can still be recoverable when the current OpenCode message/part history is available. Rebuild the old replay timeline by counting canonical host messages plus completed replayable plugin tool parts (`compression_mark`, `compression_inspect`, `compression_recall`) as synthetic sequence slots, then map old `result_groups` / `result_fragments` ranges to canonical message ids and current sequence. This was validated read-only against `ses_0f63f8c07ffe4t9s1JPGFGaPd8` before sequence repair: the old timeline had 778 slots vs 733 current host messages, with 45 synthetic slots; the heuristic matched the preserved `.in.yaml` algorithm for 31/31 result groups and 184/184 fragments.

**2026-07-05**: Batch seq repair was executed with `scripts/batch-repair-result-sequences-from-opencode.ts`. Dry-run classified current `state/` as 62 `legacy-seq-repairable`, 804 `current-correct`, 4 `unsafe`, and 1 `missing-message-source`. Apply backed up only the 62 written DBs to `.bak/db-20260705-before-seq-repair-batch`, then rewrote seq fields for 223 result groups and 983 fragments. Post-apply dry-run showed `legacy-seq-repairable=0` and `current-correct=866`; the 4 unsafe and 1 missing-message-source sessions remained untouched. Projection spot checks on `ses_0d972cbbcffeaixrvulcWAVVHu` and `ses_0d7f54fafffeO5UiIyF6K0BWFX` both reported `Uncompressed marked tokens=0`. Build passed with `npm run build -- --pretty false`.

Tags: #runtime #sqlite #schema-migration #trap #data-loss
