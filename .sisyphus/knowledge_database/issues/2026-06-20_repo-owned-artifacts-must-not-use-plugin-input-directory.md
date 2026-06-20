## repo-owned-artifacts-must-not-use-plugin-input-directory
Date: 2026-06-20

### Symptom

Live compactions completed, but no new files appeared under `opencode-context-compression/logs/compaction-records/`.

### Trigger Conditions

The artifact recorder for repo-owned runtime files was created with OpenCode `PluginInput.directory`. In live plugin execution, that value can be the host worktree or active session directory, not the plugin source repository root. Runtime config already resolves repo-owned paths from `runtimeConfig.repoRoot`, so compaction records using `PluginInput.directory` silently land under the wrong `logs/compaction-records/` tree.

### Resolution

Create repo-owned artifact recorders with `runtimeConfig.repoRoot` when wiring runtime services or startup diagnostics. Keep host-facing operations, sidecar/session state, and lock behavior on their existing paths unless the specific contract says they are repo-owned artifacts.

Tags: #runtime #artifacts #live-debug #trap
