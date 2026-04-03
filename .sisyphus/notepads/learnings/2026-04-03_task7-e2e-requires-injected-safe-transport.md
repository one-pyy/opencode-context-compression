## task7-e2e-requires-injected-safe-transport
Date: 2026-04-03

### Pattern / Gotcha
Task 7 automated end-to-end proof should exercise the real plugin entrypoint, `compression_mark`, `experimental.chat.messages.transform`, and the live `chat.params` scheduler seam, but it still needs an injected plugin-safe transport for runner execution because the scheduler's default transport intentionally fails as unavailable.

### Detail
While implementing cutover Task 7 in `/root/_/opencode/opencode-context-compression`, the key proof boundary was not plugin loading, mark persistence, or scheduler reachability. Those are real and can be exercised directly through `src/index.ts` and the returned hooks.

The limiting factor is the scheduler's current default runner transport behavior:

- `src/runtime/chat-params-scheduler.ts` accepts an optional `transport`
- when no transport is provided, it falls back to `createUnavailableCompactionTransport()`
- that fallback throws a deterministic `CompactionTransportInvocationError` with issue `unavailable`

This means the canonical live scheduler seam is present, but fully automated end-to-end runner success cannot currently rely on the default transport alone. For Task 7 proof, the stable repo-owned acceptance path is therefore:

1. load the real plugin entrypoint from `src/index.ts`
2. exercise the real `compression_mark` tool from the plugin's returned `Hooks.tool`
3. use the real `experimental.chat.messages.transform` hook to obtain visible IDs and verify final projection
4. drive the real `chat.params` scheduler seam
5. inject a safe `CompactionRunnerTransport` fixture into that scheduler call so the test proves scheduler → batch freeze → runner → SQLite commit behavior without depending on a not-yet-implemented default executor

This preserves the intended cutover proof boundary:

- the proof stays on the repo-owned plugin path
- no old DCP runtime/config/tool ownership is involved
- no nested `opencode run` process is required
- ordinary chat wait semantics and lock-time “next batch only” behavior can still be demonstrated against the real scheduler seam

What this does **not** prove is that the repo already ships a default production compaction transport executor. It proves that the plugin-owned mark flow, scheduler seam, lock semantics, SQLite persistence, and projection path are correct when given a contract-safe executor.

Future work that adds a real repo-owned default executor should update Task 7 style tests to stop injecting the transport and instead verify the default path directly.

### Applies To
- `tests/e2e/plugin-loading-and-compaction.test.ts`
- `tests/cutover/legacy-independence.test.ts`
- `src/runtime/chat-params-scheduler.ts`
- future end-to-end scheduler/runner proof in this repo
