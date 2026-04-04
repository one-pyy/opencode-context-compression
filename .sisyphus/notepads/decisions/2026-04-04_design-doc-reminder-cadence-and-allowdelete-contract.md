## design-doc-reminder-cadence-and-allowdelete-contract
Date: 2026-04-04
Task: current-session

### Decision
The repo-root `DESIGN.md` must define repeated reminders as an explicit token-based cadence (`softRepeatEveryTokens`, `hardRepeatEveryTokens`) rather than removing repeated reminders entirely, and it must treat `allowDelete=true` as a fully supported delete-permission path that can end in either normal compaction or direct deletion.

### Rationale
Two transient rewrites drifted away from the user's clarified design intent:

1. The first rewrite removed repeated reminder cadence completely and left only `hsoft` / `hhard`. That contradicted the user's clarification that repeated reminders still exist; only the old message-count-shaped field semantics were wrong.
2. The first `allowDelete` rewrite still framed delete behavior partly as a not-yet-implemented or fail-fast-only path. That contradicted the user's clarification that if the design document allows deletion, then the design must actually define the deletion path instead of treating it as a future placeholder.

The corrected contract is:
- keep repeated reminders, but express them with explicit token fields rather than `counter.source` / message-count cadence
- allow `allowDelete=true` to support both normal compaction and direct deletion as first-class design outcomes

### Alternatives Considered
- Remove repeated reminder cadence entirely: rejected because the user explicitly said cadence should remain configurable in token units.
- Keep the old `repeatEvery` / `counter.source` shape: rejected because those names and defaults carried message-count semantics that repeatedly caused design drift.
- Keep `allowDelete=true` in the design but require fail-fast until later: rejected because a target design doc should define supported behavior, not preserve a future-only placeholder while still advertising the capability.

### Consequences
`DESIGN.md` should now be read with these rules:
- reminder repetition still exists, but only through token cadence fields (`softRepeatEveryTokens`, `hardRepeatEveryTokens`)
- `counter.source` and old counter-style reminder fields are no longer part of the active design contract
- `allowDelete=true` is part of the active target design and must describe both ordinary compaction and direct-delete branches
- future code/config work should follow the new token-cadence and delete-permission vocabulary instead of reintroducing old `route` or message-count cadence semantics
