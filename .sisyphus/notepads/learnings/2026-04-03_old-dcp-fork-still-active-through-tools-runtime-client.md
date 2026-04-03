## old-dcp-fork-still-active-through-tools-runtime-client
Date: 2026-04-03

### Pattern / Gotcha
The old `opencode-dcp-fork` can still be effectively live even when it is no longer listed in `config/opencode.jsonc -> plugin`. In the current local setup, legacy DCP behavior still survives through the `config/tools/` tool entrypoints and the enabled `config/dcp-runtime.json` runtime configuration.

### Detail
The current instance plugin list in `/root/_/opencode/config/opencode.jsonc` does **not** explicitly load `opencode-dcp-fork`. It loads `opencode-context-compression/src/index.ts` instead.

However, that does not mean the old DCP system is gone from the environment.

Key evidence:

- `/root/_/opencode/config/dcp-runtime.json` currently has `"enabled": true`.
- `/root/_/opencode/config/tools/dcp_mark_for_compaction.ts` calls `loadDcpRuntimeClient()` and then invokes `runtime.registerCompactionMark(...)`.
- `/root/_/opencode/config/tools/dcp_execute_compaction.ts` also calls `loadDcpRuntimeClient()` and then invokes `runtime.executeCompaction(...)`.
- `/root/_/opencode/config/tools/dcp/runtime-client.ts` directly imports:
  - `../../plugins/opencode-dcp-fork/plugins/dcp-runtime-core.mjs`
  - `../../plugins/opencode-dcp-fork/plugins/dcp-runtime-config.mjs`
  and loads the shared DCP runtime from there.

So the current environment has a split reality:

1. **Plugin layer**
   - `opencode-context-compression` is what is explicitly loaded as an OpenCode plugin.
   - The old fork is not present in the current `plugin` array.

2. **Tool/runtime layer**
   - The exposed DCP tools still route into `opencode-dcp-fork` runtime code.
   - The runtime config for that old fork is still enabled.
   - Therefore, legacy DCP tool behavior is still live whenever those tools are invoked.

This explains why a real session can still expose `dcp_mark_for_compaction` and `dcp_execute_compaction`, and why those tools can behave according to old DCP runtime assumptions such as old message inventory / mark registry semantics.

This also explains the earlier investigation result in this repo: `opencode-context-compression` recognizes old DCP tool names in lock-gate policy, but the actual callable tool implementations are still coming from the old DCP tool path under `/root/_/opencode/config/tools/`.

### Applies To
Investigations where the plugin list appears to only load `opencode-context-compression`, but real sessions still expose old DCP tools or old DCP compaction behavior.

Relevant files:

- `/root/_/opencode/config/opencode.jsonc`
- `/root/_/opencode/config/dcp-runtime.json`
- `/root/_/opencode/config/tools/dcp_mark_for_compaction.ts`
- `/root/_/opencode/config/tools/dcp_execute_compaction.ts`
- `/root/_/opencode/config/tools/dcp/runtime-client.ts`
- `/root/_/opencode/config/plugins/opencode-dcp-fork/README.md`
