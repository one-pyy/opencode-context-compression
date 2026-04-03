## chat-params-cutover-gap-is-observer-replacement-not-missing-hook
Date: 2026-04-03

### Pattern / Gotcha
The current cutover gap around `chat.params` is not that the plugin entrypoint lacks a `chat.params` hook. `src/index.ts` already returns one because it spreads the noop observation hooks first. The real gap is that the active `chat.params` surface is still the observation seam, not a repo-owned scheduler that reaches mark persistence and the compaction runner.

### Detail
While establishing the Task 1 cutover red baseline, direct plugin initialization showed these live hook keys from `src/index.ts`:

- `chat.message`
- `chat.params`
- `experimental.chat.messages.transform`
- `tool.execute.before`

This can be misleading if someone only checks for the presence of a `chat.params` hook.

The reason it exists today is structural:

1. `src/index.ts` creates noop observation hooks from `createNoopObservationHooks(...)`
2. it initializes `const hooks: Hooks = { ...observedHooks }`
3. it later overrides `experimental.chat.messages.transform`, `chat.message`, and `tool.execute.before`
4. it does **not** override `hooks["chat.params"]`

So the returned `chat.params` hook is inherited from the noop observer layer in `src/seams/noop-observation.ts`, where it only records shape/identity observations and does not schedule compaction work.

Cutover consequence:

- a failing scheduler/live-path test should not describe the problem as “missing `chat.params` hook”
- it should describe the problem as “existing `chat.params` seam still points at noop observation instead of repo-owned scheduling/runtime callers”
- later scheduler work should replace or wrap this existing observer seam carefully, preserving the already-decided boundary that `chat.params` stays narrow and `messages.transform` remains the only projection seam

This distinction matters because a future agent could otherwise add duplicate hook wiring or misread the red baseline as an API exposure issue when the exposure already exists and only the behavior/ownership is wrong.

### Applies To
- `src/index.ts`
- `src/seams/noop-observation.ts`
- `tests/cutover/scheduler-live-path.test.ts`
- future cutover work that wires repo-owned scheduling into `chat.params`
