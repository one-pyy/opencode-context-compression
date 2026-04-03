## mark-tool-exposure-boundary
Date: 2026-04-03

### Pattern / Gotcha
`opencode-context-compression` currently contains the new mark pipeline only as internal sidecar/runtime implementation. This repository does **not** itself expose a new public mark tool that OpenCode can invoke directly. The legacy names `dcp_mark` and `dcp_mark_for_compaction` appear in runtime gate policy, not as tool registration in this repo.

### Detail
The strongest public-surface evidence is `src/index.ts`. The plugin default export builds and returns hook handlers for `experimental.chat.messages.transform`, `chat.message`, and `tool.execute.before`. No repo-local tool registration/export surface was found alongside that entrypoint.

`package.json` and `README.md` are consistent with that shape: the repo is loaded as a plugin from `src/index.ts`, and the documented activation path is explicit plugin loading rather than adding a new tool definition.

The new mark flow does exist internally:

- `src/marks/mark-service.ts` implements `captureMarkSourceSnapshot()` and `persistMark()`, with `persistMark()` ultimately calling `store.createMark(...)` to persist marks and source snapshots into the SQLite sidecar.
- `src/marks/batch-freeze.ts` implements `freezeCurrentCompactionBatch()`, which freezes active marks and persists a compaction batch.
- `src/compaction/runner.ts` uses `freezeCurrentCompactionBatch()` as part of the internal compaction pipeline.

But that internal implementation is not the same thing as a public mark tool. A repo-local search showed:

- `persistMark()` has no non-test runtime caller in `src/`; it is present as internal mark persistence logic, not as a discovered tool entrypoint.
- The legacy names `dcp_mark` and `dcp_mark_for_compaction` appear in `src/runtime/send-entry-gate.ts` as `DEFAULT_DCP_MARK_TOOL_NAMES` and in `src/runtime/lock-gate.ts` as the `dcp-mark-tool` path classification input.
- That runtime code only decides whether ordinary chat waits, whether legacy mark-tool names bypass an active lock, and whether blocked executors such as `dcp_execute_compaction` are rejected during a live batch.

The docs reinforce the same boundary. `docs/live-verification-with-mitmproxy-and-debug-log.zh.md` phrases the behavior as “if the current profile exposes DCP tools,” which implies those tools may come from the surrounding profile/toolchain rather than from this repo’s own public plugin surface.

Operational consequence: if a live session or test environment still exposes `dcp_mark_for_compaction`, do not assume that means this repository already shipped a new public mark tool. In this repo, that old name is only recognized by lock-gating policy unless some external profile/plugin provides the actual callable tool.

### Applies To
Investigations about why real sessions still show old DCP tool names, why marks do not enter the new sidecar flow, and whether the new mark pipeline has been publicly exposed yet.

Relevant files:

- `src/index.ts`
- `src/runtime/send-entry-gate.ts`
- `src/runtime/lock-gate.ts`
- `src/marks/mark-service.ts`
- `src/marks/batch-freeze.ts`
- `src/compaction/runner.ts`
- `README.md`
- `docs/live-verification-with-mitmproxy-and-debug-log.zh.md`
