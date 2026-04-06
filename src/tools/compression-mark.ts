/**
 * TODO(new-project): rewrite compression_mark from DESIGN.md.
 *
 * Direction:
 * - treat history tool calls as the mark intent source of truth
 * - accept mode=compact|delete with delete admission checked only at call time
 * - stop persisting mark/source snapshot truth into SQLite
 * - return mark id for replay/result-group lookup instead of building legacy mark records
 * - resolve visible targets against the current projected transcript without compatibility selectors
 */
export {};
