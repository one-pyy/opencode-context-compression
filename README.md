# opencode-context-compression

Standalone OpenCode plugin workspace for the canonical-history + SQLite-sidecar context compression design.

This plugin keeps OpenCode host history as the canonical source of truth, stores plugin-owned state in a per-session SQLite sidecar, projects prompt-visible replacements through `experimental.chat.messages.transform`, and uses a file lock as the operator-visible live compaction gate.

## Load the plugin explicitly

Use an explicit plugin entry in `opencode.json` or `opencode.jsonc`. In this workspace, explicit config loading is the supported activation path.

```jsonc
{
  "plugin": [
    "/root/_/opencode/opencode-context-compression/src/index.ts"
  ]
}
```

Important operator notes:

- Use the absolute path above as the source of truth for this local checkout.
- Restart OpenCode after changing the plugin list.
- Do not rely on directory auto-loading for this repo.

## Repo-owned runtime config, prompt, and log contract

The plugin's canonical runtime contract now ships inside this repo:

- `src/config/runtime-config.json` — canonical runtime settings file
- `prompts/compaction.md` — explicit compaction prompt asset
- `logs/runtime-events.jsonl` — repo-owned runtime log path contract
- `logs/seam-observation.jsonl` — repo-owned seam/debug journal path

Prompt loading is explicit. The plugin loads the configured prompt file and fails fast if the config file or prompt asset is missing, empty, or malformed. There is no builtin prompt fallback and no legacy runtime-config fallback.

### Env override names and precedence

Precedence is deterministic:

1. `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH` selects an alternate config file.
2. Field-specific env overrides replace values from that config file:
   - `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`
   - `OPENCODE_CONTEXT_COMPRESSION_MODELS` (comma-separated ordered model array)
   - `OPENCODE_CONTEXT_COMPRESSION_ROUTE` (`keep` or `delete`)
   - `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH`
   - `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG`
   - `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`

Unset env variables mean "no override". Empty or whitespace-only env values are rejected at plugin startup so they cannot silently behave like unset values.

## Disable competing compression paths first

This plugin is designed to be the only prompt-compaction system active for a session. Do not run it alongside other transcript-rewriting or auto-compaction paths.

Disable or remove all of the following before enabling this plugin:

- `opencode-dcp-fork`
  - remove its plugin entry from your OpenCode config
  - do not route this plugin through fork-owned runtime config or prompt assets
- `@tarquinen/opencode-dcp`
  - remove it from the OpenCode `plugin` list for the same session/profile
- any other transform/compaction plugins
  - if a plugin rewrites transcript messages, injects replacement blocks, summarizes automatically, or performs its own context-pruning policy, disable it for the same profile
- native OpenCode auto summarize / compaction
  - set `compaction.auto` to `false`
  - set `compaction.prune` to `false`

Minimal example:

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

Why this matters: the plugin assumes it is the only component deciding when source spans are replaced, hidden, or deleted from the prompt-visible projection. Running multiple compression systems at once makes replacement matching, lock recovery, and sidecar state interpretation unreliable.

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
   - unrelated tools continue, and DCP mark tools stay outside the already-frozen batch
4. **Projection is deterministic**
   - committed replacements are rendered from sidecar state through `experimental.chat.messages.transform`
   - rerunning projection over the same canonical history yields the same visible output

## `route=keep` and `route=delete`

Both routes use the same mark -> source snapshot -> replacement -> projection pipeline. `route=delete` is not a separate deletion subsystem.

### `route=keep`

- a committed replacement stays prompt-visible as the surviving referable block
- the original source span is hidden only in the projected view
- the replacement is not eligible for another compaction pass

### `route=delete`

- compaction still creates a committed replacement record in SQLite
- projection renders that committed result as a minimal delete notice instead of a reusable summary block
- the original source span is removed from the prompt-visible projection once the delete replacement is committed
- the delete result is still tracked through the same replacement tables, source snapshots, and consumed-mark links as `route=keep`
- delete outputs are treated as terminal cleanup results, not as candidates for another compaction pass

In short: `keep` leaves a compacted survivor, while `delete` leaves only a minimal referable notice.

## Lock behavior and manual recovery

The live compaction gate is the session lock file:

- path: `locks/<session-id>.lock`
- created when a frozen compaction batch actually starts
- cleared after the batch reaches a terminal result and all attempts are finished
- stale locks are ignored automatically after the configured timeout window

What happens during a live lock:

- ordinary chat waits until the batch succeeds, fails, times out, or is manually cleared
- non-DCP tools continue to run
- DCP mark tools may still register future marks, but those marks do not join the already-frozen batch

### Manual lock recovery

If a session is stuck because the operator-visible lock file was left behind unexpectedly, remove only the affected session lock file:

```bash
rm "/root/_/opencode/opencode-context-compression/locks/<session-id>.lock"
```

Use manual lock removal only for a session you have confirmed is no longer actively compacting. The next request will treat the missing live lock as manual recovery and resolve final outcome from persisted batch state if available.

## Sidecar layout

By default this repo writes state relative to the plugin directory:

- `state/<session-id>.db` — SQLite sidecar database
- `locks/<session-id>.lock` — live compaction lock file
- `logs/runtime-events.jsonl` — repo-owned runtime log path contract
- `logs/seam-observation.jsonl` — seam-debug journal when seam logging is enabled

Debug snapshots are disabled by default. Set `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH` to enable them; relative paths resolve from this repo root.

The sidecar database is the main operator inspection surface for accepted marks, committed replacements, batch/job status, and runtime gate audit records.

## End-to-end acceptance coverage in this repo

The repo ships end-to-end tests that cover the operator-facing behaviors this README describes:

- explicit absolute-path plugin loading into a temp project and sidecar creation
- deterministic projection reruns for committed `route=keep` replacements
- successful `route=delete` commit and minimal projected delete notice
- SQLite verification with `sqlite3` for committed keep/delete records
- live-lock waiting behavior that resolves from persisted batch state after unlock

Run them with:

```bash
node --import tsx --test tests/e2e/**/*.test.ts
```

Run the full repo verification with:

```bash
npm run typecheck
node --import tsx --test tests/**/*.test.ts
```

## Seam probe

For seam-debug work, the repo still includes the temporary-config probe runner:

```bash
npm run probe:seams
```

What it does:

- creates a temporary `OPENCODE_CONFIG_DIR` under `.tmp/opencode-config/`
- writes an explicit plugin entry for this repo's `src/index.ts`
- runs a minimal `opencode run`
- records hook observations to `logs/seam-observation.jsonl`

Use the seam probe when you need raw hook-shape evidence. Use the e2e suite when you need repeatable operator-facing acceptance proof.
