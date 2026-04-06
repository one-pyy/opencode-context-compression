/**
 * TODO(new-project): rewrite compaction runner from DESIGN.md.
 *
 * Direction:
 * - execute against replay-derived legal top-level work, not legacy persisted mark truth
 * - commit result groups atomically by mark id
 * - keep retry/fallback only if it still matches the new transport contract
 * - remove legacy batch/job/sourceSnapshot coupling where no longer justified
 */
export {};
