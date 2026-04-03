## scheduler-cutover-defaults-and-config-compat
Date: 2026-04-03

### Pattern / Gotcha
When wiring the repo-owned scheduler into `chat.params`, the production/default path must stay non-blocking, and any new field added to the repo-owned runtime config must preserve older accepted fixtures through deterministic defaults rather than turning the extension into a mandatory breaking contract.

### Detail
Task 4 replaced the inherited noop `chat.params` seam with a real repo-owned scheduler hook that can sync canonical session history, inspect active marks, and invoke `runCompactionBatch()`.

Two follow-up verification catches turned into durable rules:

1. **Default `chat.params` behavior must remain backgrounded**
   - The first scheduler implementation only awaited the scheduler run when `runInBackground` was falsy.
   - Because the production entrypoint did not pass `runInBackground`, the default path treated `undefined` like `false` and awaited the full scheduler run.
   - That silently moved ordinary wait authority out of `src/runtime/send-entry-gate.ts` and into `chat.params`, violating the cutover boundary even though targeted tests still passed.
   - The safe contract is:
     - production/default path: background scheduling, immediate return
     - explicit test/control path: pass `runInBackground: false` only when a caller intentionally wants synchronous completion for deterministic assertions

2. **New repo-owned runtime-config fields should default compatibly**
   - Task 4 introduced `schedulerMarkThreshold` to support deterministic scheduler triggering.
   - Making that field required immediately broke the already-accepted Task 2 runtime-config precedence tests, because older repo-owned fixture configs did not yet declare it.
   - The correct extension shape is to parse the field when present, validate it strictly, and otherwise supply one deterministic default in code.
   - This keeps the new scheduler capability available without retroactively invalidating the accepted repo-owned config contract from earlier cutover tasks.

Operationally, owner verification should treat these as separate failure classes:
- targeted scheduler tests can still pass while the default production `chat.params` return semantics are wrong
- a newly added config field can regress earlier accepted tests even if the new task's narrow tests stay green

### Applies To
`src/runtime/chat-params-scheduler.ts`, `src/index.ts`, `src/config/runtime-config.ts`, `tests/cutover/scheduler-live-path.test.ts`, `tests/cutover/runtime-config-precedence.test.ts`, and future cutover work that extends scheduler/runtime config behavior.
