## scheduler-must-use-sidecar-visible-id-truth
Date: 2026-04-26

### Pattern

Any runtime path that consumes `compression_mark.from/to` must resolve visible ids through the sidecar `visible_sequence_allocations` table, not by recomputing ids from current replay order.

### Detail

`compression_mark.from/to` is emitted by the model from the projected visible world. That visible world uses persisted visible sequences in `state.db`. Host history is not append-only: a session can be rolled back, pruned, or otherwise returned without messages that previously received visible sequence allocations.

When `chat.params` recomputed visible ids from current replay sequence, the checksum suffix from canonical message id still matched, but the six-digit visible sequence drifted. Example: a message persisted as `compressible_000047_xF` could replay later as `compressible_000043_xF` after four earlier messages disappeared from host history. The mark endpoint existed in `state.db`, but the scheduler's temporary visible-id map could not resolve it, so valid marks were excluded from the mark tree and never entered pending compaction.

Treat fallback visible-id generation in scheduling/runtime paths as unsafe unless the path is an isolated test with an explicit fake identity service.

### Applies To

Projection, `compression_mark` replay, `chat.params` scheduling, pending compaction eligibility, and any future feature that resolves model-visible message ids back to canonical messages.

Tags: #visible-id #scheduler #sidecar #runtime #trap
