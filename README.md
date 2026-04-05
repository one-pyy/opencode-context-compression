# opencode-context-compression

Standalone OpenCode plugin workspace for the canonical-history plus SQLite-sidecar context compression design.

The plugin keeps OpenCode host history as the canonical source of truth, stores plugin-owned state in a per-session SQLite sidecar, projects prompt-visible replacements through `experimental.chat.messages.transform`, and uses a file lock as the operator-visible live compaction gate. Its only public compaction tool is `compression_mark`.

## Load the plugin explicitly

Use an explicit plugin entry in `opencode.json` or `opencode.jsonc`. In this workspace, explicit config loading is the supported activation path.

```jsonc
{
  "plugin": [
    "/root/_/opencode/opencode-context-compression/src/index.ts"
  ]
}
```

Operator notes:

- Use the absolute path above as the source of truth for this local checkout.
- Restart OpenCode after changing the plugin list.
- Do not rely on directory auto-loading for this repo.

## Repo-owned runtime config, prompt, and log contract

The canonical runtime contract ships inside this repo:

- `src/config/runtime-config.jsonc`, canonical runtime settings file
- `src/config/runtime-config.schema.json`, local JSON Schema for editor validation and `$schema` wiring
- `prompts/compaction.md`, explicit compaction prompt asset
- `prompts/reminder-soft-compact-only.md`, soft reminder text when the current context only allows compaction
- `prompts/reminder-hard-compact-only.md`, hard reminder text when the current context only allows compaction
- `prompts/reminder-soft-delete-allowed.md`, soft reminder text when the current context allows deletion
- `prompts/reminder-hard-delete-allowed.md`, hard reminder text when the current context allows deletion
- `logs/runtime-events.jsonl`, repo-owned runtime log path contract
- `logs/seam-observation.jsonl`, repo-owned seam and debug journal path

Prompt loading is explicit. The plugin loads the configured prompt file and fails fast if the config file or prompt asset is missing, empty, or malformed. There is no builtin prompt fallback and no legacy runtime-config fallback.

### Restored runtime config surface

The repo-owned `runtime-config.jsonc` now restores the preserved user-facing contract instead of only exposing the cutover-minimal fields.

The canonical config is now comment-capable and carries a local `$schema` reference to `src/config/runtime-config.schema.json` for editor-aware validation.

- `markedTokenAutoCompactionThreshold`, explicit external readiness contract carried forward from older DCP work
- `smallUserMessageThreshold`, explicit preserved user-message threshold contract for protecting short user messages in projection
- `reminder.hsoft` and `reminder.hhard`, explicit soft and hard reminder token thresholds (repo default: `30000` / `70000`)
- `reminder.softRepeatEveryTokens` and `reminder.hardRepeatEveryTokens`, token-based reminder repeat cadence
- `reminder.promptPaths.compactOnly.*` and `reminder.promptPaths.deleteAllowed.*`, repo-owned reminder text asset paths
- `logging.level`, explicit logging control surface
- `compressing.timeoutSeconds`, explicit compaction and lock timeout control
- `schedulerMarkThreshold`, internal/test compatibility knob for current mark-count scheduling only

Important distinction: `schedulerMarkThreshold` is not the same contract as `markedTokenAutoCompactionThreshold`. `schedulerMarkThreshold` remains an internal compatibility guard, while runtime scheduling now also enforces marked-token readiness against `markedTokenAutoCompactionThreshold`.

Current enforcement boundary in this repo:

- `softRepeatEveryTokens` / `hardRepeatEveryTokens` — enforced by deterministic reminder derivation
- `smallUserMessageThreshold` — enforced by projection visibility policy for short user messages
- `markedTokenAutoCompactionThreshold` — enforced by scheduler marked-token readiness
- `logging.level` — enforced by the runtime event JSONL sink at `runtimeLogPath`

Token-estimation policy in this repo:

1. estimate threshold decisions with the repo-owned local `tiktoken` path
2. if tokenizer resolution or encoding fails, threshold evaluation now fails fast with a plugin-owned error

Threshold decisions in this repo do not prefer upstream-provided `tokenCount` or `metadata.*tokenCount` fields; reminder and marked-token readiness both use the same local tokenizer-based ruler, and tokenizer failure is not silently downgraded to a heuristic guess.

Runtime logging behavior in this repo:

- `off` — do not persist normal runtime events to `runtimeLogPath`
- `error` — persist only failure/stale runtime gate events
- `info` and `debug` — persist normal runtime gate events as JSONL to `runtimeLogPath`

### Reminder prompt assets

Reminder text now comes from four repo-owned plain-text assets instead of hardcoded strings:

- `prompts/reminder-soft-compact-only.md`
- `prompts/reminder-hard-compact-only.md`
- `prompts/reminder-soft-delete-allowed.md`
- `prompts/reminder-hard-delete-allowed.md`

These reminder assets are loaded explicitly and must contain non-empty text, but they are not template files and do not require placeholder variables. `prompts/compaction.md` remains the prompt asset that carries the compaction-template role.

### Env override names and precedence

Precedence is deterministic:

1. `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH` selects an alternate config file.
2. Field-specific env overrides replace values from that config file:
   - `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`
   - `OPENCODE_CONTEXT_COMPRESSION_MODELS`, comma-separated ordered model array
   - `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH`
   - `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG`
   - `OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL`, `off`, `error`, `info`, or `debug`
   - `OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS`, positive integer seconds
   - `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`

Unset env variables mean "no override". Empty or whitespace-only env values are rejected at plugin startup so they cannot silently behave like unset values.

## Public tool contract

The only public compaction tool is `compression_mark`.

- `contractVersion` is `v1`
- `allowDelete` is a boolean delete-permission bit for the selected visible span
- `target.startVisibleMessageID` and `target.endVisibleMessageID` come from the current projected visible view
- the tool resolves the target span against the repo-owned projection, then persists the mark and source snapshot in the sidecar

`compression_mark` does not expose a public execute step. Batch freezing, scheduling, runner invocation, and lock handling remain plugin-owned runtime behavior behind the tool and scheduler seams.

## Run it as the only active compaction system

This plugin should be the only prompt-compaction system active for a session. Disable any other transform or compaction plugin that rewrites transcript messages, injects replacement blocks, summarizes automatically, or applies its own context-pruning policy.

Also disable native OpenCode auto summarize and prune for the same profile:

```jsonc
{
  "plugin": [
    "/root/_/opencode/opencode-context-compression/src/index.ts"
  ],
  "compaction": {
    "auto": false,
    "prune": false
  }
}
```

Why this matters: the plugin assumes it is the only component deciding when source spans are replaced, hidden, or removed from the prompt-visible projection. Running multiple compaction systems at once makes replacement matching, lock recovery, and sidecar state interpretation unreliable.

## Runtime model in one page

The plugin is organized around four operator-visible rules:

1. **Canonical history stays upstream-owned**
   - the plugin does not overwrite host history
   - each transform run re-syncs live host messages into the sidecar before projecting replacements
2. **SQLite is sidecar state, not a second transcript**
   - each session gets a database under `state/<session-id>.db`
   - marks, source snapshots, replacements, compaction batches, jobs, and runtime gate observations live there
3. **The file lock is the live compaction gate**
   - an active batch writes `locks/<session-id>.lock`
   - ordinary chat waits on that lock
   - unrelated tools continue, and `compression_mark` stays outside the already-frozen batch
4. **Projection is deterministic**
   - committed replacements are rendered from sidecar state through `experimental.chat.messages.transform`
   - rerunning projection over the same canonical history yields the same visible output

## `allowDelete` and committed `executionMode`

The durable mark and source-lineage contract now records delete permission as `allowDelete`, while committed replacements record the actual outcome as `executionMode`.

### `allowDelete`

- `allowDelete: false` means the marked span may be compacted but is not permitted to enter the delete branch
- `allowDelete: true` means the marked span is allowed to enter the delete-capable branch later
- `allowDelete` is a permission bit, not a standalone record of what the current batch actually did

### committed `executionMode="compact"`

- a committed replacement stays prompt-visible as the surviving referable block
- the original source span is hidden only in the projected view
- the replacement is not eligible for another compaction pass

### committed `executionMode="delete"`

- compaction still creates a committed replacement record in SQLite
- projection renders that committed result as a minimal delete notice instead of a reusable summary block
- the original source span is removed from the prompt-visible projection once the delete replacement is committed
- the delete result is still tracked through the same replacement tables, source snapshots, and consumed-mark links as compact outcomes
- delete outputs are treated as terminal cleanup results, not as candidates for another compaction pass

In short, `allowDelete` records permission, while `executionMode` records whether the committed outcome was a compacted survivor or a delete notice.

## Lock behavior and manual recovery

The live compaction gate is the session lock file:

- path: `locks/<session-id>.lock`
- created when a frozen compaction batch actually starts
- cleared after the batch reaches a terminal result and all attempts are finished
- stale locks are ignored automatically after the configured timeout window

What happens during a live lock:

- ordinary chat waits until the batch succeeds, fails, times out, or is manually cleared
- non-compaction tools continue to run
- `compression_mark` may still register future marks, but those marks do not join the already-frozen batch

### Manual lock recovery

If a session is stuck because the operator-visible lock file was left behind unexpectedly, remove only the affected session lock file:

```bash
rm "/root/_/opencode/opencode-context-compression/locks/<session-id>.lock"
```

Use manual lock removal only for a session you have confirmed is no longer actively compacting. The next request will treat the missing live lock as manual recovery and resolve final outcome from persisted batch state if available.

## Sidecar layout

By default this repo writes state relative to the plugin directory:

- `state/<session-id>.db`, SQLite sidecar database
- `locks/<session-id>.lock`, live compaction lock file
- `logs/runtime-events.jsonl`, repo-owned runtime log path contract
- `logs/seam-observation.jsonl`, seam journal when seam logging is enabled

Debug snapshots are disabled by default. Set `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH` to enable them. Relative paths resolve from this repo root.

The sidecar database is the main operator inspection surface for accepted marks, committed replacements, batch and job status, and runtime gate audit records.

## Verification truth boundary

This repo has automated proof for the repo-owned contract, but the proof boundary matters.

Automated proof that is in scope today:

- `tests/cutover/runtime-config-precedence.test.ts`, repo-owned config, prompt, log, and env precedence
- `tests/cutover/legacy-independence.test.ts`, canonical execution without old runtime, tool, or provider ownership
- `tests/cutover/docs-and-notepad-contract.test.ts`, operator docs and durable-memory contract audit
- `tests/e2e/plugin-loading-and-compaction.test.ts`, repo-owned plugin loading, mark flow, scheduler seam, and committed replacement path with an injected safe transport fixture
- `tests/e2e/delete-route.test.ts`, committed delete-path behavior under the same repo-owned fixture style

What this README does not claim:

- that host-exposed legacy tools already provide valid end-to-end keep and delete proof for this plugin in a real session
- that the repo already ships a default production compaction executor transport

For current manual guidance, read `docs/live-verification-with-mitmproxy-and-debug-log.zh.md`. That guide keeps the same truth boundary: real-session checks may confirm plugin load, seam logging, sidecar creation, and other observable runtime effects, but full keep and delete proof still comes from the repo-owned automated suite above.

## Seam probe

For seam-debug work, the repo includes a probe runner:

```bash
npm run probe:seams
```

What it does:

- creates a temporary `OPENCODE_CONFIG_DIR` under `.tmp/opencode-config/`
- writes an explicit plugin entry for this repo's `src/index.ts`
- runs a minimal `opencode run`
- records hook observations to `logs/seam-observation.jsonl`

Use the seam probe when you need raw hook-shape evidence. Use the cutover tests and e2e suite when you need repeatable proof of the repo-owned contract.

## Verification commands

From `/root/_/opencode/opencode-context-compression`:

```bash
npm run typecheck
node --import tsx --test tests/cutover/runtime-config-precedence.test.ts
node --import tsx --test tests/cutover/legacy-independence.test.ts
node --import tsx --test tests/cutover/docs-and-notepad-contract.test.ts
node --import tsx --test tests/e2e/plugin-loading-and-compaction.test.ts
node --import tsx --test tests/e2e/delete-route.test.ts
```
