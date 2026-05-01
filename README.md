# opencode-context-compression

Experimental OpenCode plugin for context compression. It reduces the prompt-visible conversation window by projecting canonical host history through a SQLite sidecar and replacing marked ranges with compacted results.

This repository is intended to be public as source code and design reference. It is not an npm-published package yet; `package.json` is still marked `private`.

## What it does

- Adds a `compression_mark` tool for marking message ranges that should be compacted or deleted.
- Keeps OpenCode host history as the source of truth. The plugin does not rewrite, delete, or mutate canonical host history.
- Stores derived state, accepted marks, compaction results, visible IDs, and runtime state in a SQLite sidecar.
- Builds a deterministic prompt-visible projection from host history plus sidecar state.
- Runs compaction asynchronously and lets later turns consume completed result groups.
- Shows soft and hard reminders when marked or visible context crosses configured token thresholds.

## Boundaries

This project is still experimental. Some docs describe both implemented and partially implemented behavior; read the status labels before treating a document as current runtime truth.

Important boundaries:

- This plugin should be the only active context compression or summarization plugin for a session.
- `compression_mark` records intent. It does not itself run compaction or rewrite the prompt.
- `mode: "delete"` is gated by `allowDelete`; when deletion is not allowed, delete marks are rejected.
- SQLite sidecar data is derived state, not a second canonical conversation history.
- Exact provider prompt-cache prefixes may change after projection replaces earlier visible content.
- Local logs, state, locks, runtime proofs, and temporary investigation files are not part of the public product surface.

## Configuration

The live runtime config defaults to:

```text
~/.config/opencode/opencode-context-compression.jsonc
```

Use the repository template as the starting point:

```text
src/config/runtime-config.jsonc
```

Common fields:

- `allowDelete`: enables or disables `mode: "delete"` marks.
- `promptPath`: compaction prompt path, resolved from the repository root.
- `leadingUserPromptPath`: prompt used for leading user projection behavior.
- `compactionModels`: ordered model fallback list used by compaction transport.
- `markedTokenAutoCompactionThreshold`: token threshold for marked-token readiness.
- `smallUserMessageThreshold`: threshold used by projection policy for small user messages.
- `reminder.hsoft` / `reminder.hhard`: soft and hard reminder thresholds.
- `reminder.softRepeatEveryTokens` / `reminder.hardRepeatEveryTokens`: token-based reminder cadence.
- `runtimeLogPath`, `seamLogPath`, `debugSnapshotPath`: local diagnostic output paths.
- `compressing.timeoutSeconds`, `compressing.firstTokenTimeoutSeconds`, `compressing.streamIdleTimeoutSeconds`: compaction timeout settings.
- `toast.enabled` and `toast.durations.*`: UI toast behavior.

Environment overrides:

- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_ALLOW_DELETE`
- `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_MODELS`
- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG`
- `OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL`
- `OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS`
- `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_URL`

Token counting prefers a local Python `tiktoken` service:

```sh
npm run token-counter
```

If that service is unavailable, the TypeScript runtime falls back to a character-count estimate.

## Development

Install dependencies:

```sh
npm install
```

Type-check:

```sh
npm run typecheck
```

Run tests:

```sh
npm test
```

Build:

```sh
npm run build
```

## Documentation for humans and AI agents

Before changing behavior, read the project docs under `.sisyphus/docs/`. The remaining `.sisyphus` content in this branch is intentionally public project material unless a future change explicitly ignores it.

Start here:

- `.sisyphus/docs/INDEX.md`
- `.sisyphus/docs/architecture/system-overview.md`
- `.sisyphus/docs/architecture/runtime-model.md`
- `.sisyphus/docs/config/runtime-config-surface.md`
- `.sisyphus/docs/compaction/mark-tool-contract.md`
- `.sisyphus/docs/compaction/compaction-lifecycle.md`
- `.sisyphus/docs/projection/projection-rules.md`

Rules for AI agents working on this repository:

- Read `.sisyphus/docs/INDEX.md` before editing code. Reason: the docs distinguish current implementation from target or partially implemented behavior.
- Follow status labels such as `已实现`, `半实现`, and `未实现`. Reason: treating target design as implemented behavior causes incorrect changes.
- Do not rewrite host history or treat sidecar data as canonical history. Reason: the architecture depends on host history remaining the only source of truth.
- Do not edit prompt assets casually. Reason: prompt files are runtime inputs, not explanatory documentation.
- Keep changes narrow and verify them with the closest relevant test or type check. Reason: projection and compaction behavior are sensitive to small contract changes.

## Public repository hygiene

The remaining tracked `.sisyphus` tree is public for this branch.

Ignored `.sisyphus` subtrees such as evidence, temporary files, and next-plan drafts are local-only and should stay out of the public repository.

Do not publish local runtime directories such as `logs/`, `state/`, `locks/`, `.tmp/`, `node_modules/`, or `.venv-token-counter/`.
