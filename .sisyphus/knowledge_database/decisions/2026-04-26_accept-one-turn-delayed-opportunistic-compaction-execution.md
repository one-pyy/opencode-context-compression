## accept-one-turn-delayed-opportunistic-compaction-execution
Date: 2026-04-26

### Decision

Accept the current one-turn delayed background compaction execution model as a feature: `chat.params` schedules pending marks, and the next `messages.transform` tail invokes the executor.

### Rationale

The executor currently needs complete projection state, including replayed history, mark tree, message policies, visible-id allocations, result groups, and failure state. That complete state is already produced by `messages.transform`, while `chat.params` computes only the scheduling minimum: eligible marks, token threshold status, committed result group ids, and metadata.

Keeping execution attached to the `messages.transform` tail avoids duplicating projection-state construction inside `chat.params` and keeps the executor input shape stable.

### Alternatives Considered

- Start executor immediately inside `chat.params`: rejected for now because `chat.params` does not own full projection state; doing this correctly would require rebuilding or transporting projection state at the scheduling seam.
- Block the same request immediately after scheduling: rejected for now because lock/gate behavior currently lives at the start of `messages.transform`; forcing same-turn blocking would require a new send-path interception contract.
- Keep executor as a timer/daemon: rejected because it would add a separate lifecycle owner and make lock/batch visibility harder to reason about.

### Consequences

One model request may pass after `chat.params` schedules pending compaction but before the next `messages.transform` starts the executor and lock. This is expected current behavior, not a startup-latency bug. Future work that wants same-turn compression must first move or reconstruct full projection state at the scheduling boundary.

Tags: #compaction #scheduler #runtime #lifecycle #architecture
