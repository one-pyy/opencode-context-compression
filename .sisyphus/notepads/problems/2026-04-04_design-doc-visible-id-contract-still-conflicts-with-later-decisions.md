## design-doc-visible-id-contract-still-conflicts-with-later-decisions
Date: 2026-04-04
Task: current-session

### Symptom
`DESIGN.md` still shows role-prefixed visible-id examples such as `user_000001_q7`, `assistant_000002_m2`, and `tool_000003_k9`, while later April 2 decisions require a single-exit visible-id renderer and a model-visible three-state prefix contract (`protected` / `referable` / `compressible`).

### Trigger Conditions
This appears when comparing the current repo-root `DESIGN.md` against these later durable decisions:
- `decisions/2026-04-02_visible-id-single-exit-with-assistant-shell-normalization.md`
- `decisions/2026-04-02_visible-id-three-state-prefix-and-frontier-id-inheritance.md`
- `learnings/2026-04-02_dcp-three-state-render-prefix-must-wrap-bare-visible-id.md`

### Attempts
- [Design-doc migration]: Reworked `DESIGN.md` to replace `route` with `allowDelete` and remove `repeatEvery` / `counter.source` from the active reminder contract. This fixed the reminder/delete-permission side of the design but did not yet reconcile visible-id output examples with the newer three-state output contract.
- [Cross-check with recent decisions]: Re-read the later April 2 visible-id decisions and confirmed the mismatch is real, not just a wording preference. The current doc still mixes older role-prefixed examples with newer single-exit and three-state rendering requirements.

### Resolution
UNRESOLVED

The next design-doc pass should reconcile these layers explicitly:
1. bare canonical visible id stored in metadata
2. single-exit text rendering rule
3. whether the current plugin design should present role-prefixed examples or three-state (`protected` / `referable` / `compressible`) model-visible prefixes

### Side Effects
none
