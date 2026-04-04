## design-contract-audit-shows-code-still-on-legacy-route-reminder-and-rendering-contract
Date: 2026-04-04
Task: current-session

### Symptom
Comparing `DESIGN-CHANGELOG.zh.md` and `DESIGN.md` against the current repository shows that the implementation still follows the older route-centric and count-cadence contract in several core areas. Observed mismatches include:

- runtime config/schema still expose root-level `route`, `reminder.promptPaths.soft/hard`, and `reminder.counter.*`
- reminder derivation still excludes `tool` messages from token counting and repeats by message/assistant-turn cadence instead of token cadence
- prompt assets still ship only `prompts/reminder-soft.md` and `prompts/reminder-hard.md`
- projection rendering still uses generic `[state_visibleId]` prefixing instead of the newer specialized assistant/tool rendering rules
- replacement resolution still selects the earliest committed equivalent replacement instead of the latest one

### Trigger Conditions
This appears when a later implementation task treats the repo-root design docs as the target contract and then checks the current code paths under:

- `src/config/runtime-config.ts`
- `src/config/runtime-config.schema.json`
- `src/config/runtime-config.jsonc`
- `src/projection/reminder-service.ts`
- `src/projection/projection-builder.ts`
- `src/tools/compression-mark.ts`
- `src/state/store.ts`
- current reminder prompt assets under `prompts/`
- tests under `tests/projection/`, `tests/cutover/`, and `tests/e2e/`

### Attempts
- [Design-first audit]: Read `DESIGN-CHANGELOG.zh.md` before `DESIGN.md` to distinguish target design from already-observed implementation facts.
- [Config/reminder audit]: Checked runtime config loader, schema, checked-in JSONC config, reminder derivation, prompt assets, and related tests; confirmed the code is still built around `route`, two reminder files, and counter-style cadence.
- [Projection/rendering audit]: Checked projection builder, visible-id render path, compression mark tool, replacement lookup behavior, and related tests; confirmed the code still uses generic prefix rewriting and earliest-match replacement selection.

### Resolution
UNRESOLVED

The next implementation pass should treat this as a cross-cutting migration rather than a local bugfix. The highest-value next steps are:

1. replace root `route` semantics with local `allowDelete` semantics across config, mark persistence, compaction input/output, replacement matching, and projection
2. replace `reminder.counter.*` with explicit token cadence fields and include `tool` messages in compressible-token accounting
3. replace the two reminder assets with four severity × allowDelete plain-text prompt files and wire selection accordingly
4. update projection to implement the assistant-body prepend rule, tool-only assistant shell rule, and per-tool msg-id insertion rule
5. change replacement multi-match selection from earliest committed to latest committed
6. rewrite affected tests and any stale docs/README sections that still describe the old contract

### Side Effects
This is a broad but coherent migration surface. Attempting to change only one layer (for example config only, or projection only) is likely to leave the repo in a mixed-contract state where docs, runtime behavior, and tests disagree.
