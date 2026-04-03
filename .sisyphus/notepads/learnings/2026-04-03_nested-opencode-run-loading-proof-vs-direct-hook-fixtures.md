## nested-opencode-run-loading-proof-vs-direct-hook-fixtures
Date: 2026-04-03

### Pattern / Gotcha
For this repo, nested `opencode run` launches from inside the Node test harness were unreliable as automated plugin-loading proof. The stable acceptance-test path was to import the plugin entry directly, initialize it with a temp project directory, and exercise the returned hooks against temp project state.

### Detail
While implementing Task 11 end-to-end coverage in `/root/_/opencode/opencode-context-compression`, the first loading-proof design tried to demonstrate explicit plugin activation by launching real `opencode run` child processes from `node:test`.

Several plausible variants were tried:

- `spawn(..., stdio: "inherit")` from the test runner
- `execFileSync(...)` with captured stdout
- `spawn(..., stdio: ["ignore", "pipe", "pipe"])`
- `spawn(..., stdio: ["ignore", "inherit", "inherit"])`

Observed behavior was inconsistent in a way that made these paths poor automated acceptance proof:

- one variant hung under `node:test` even though the equivalent standalone reproduction completed quickly
- synchronous and piped variants could return `OK` without creating the expected seam journal file
- the child-launch behavior was therefore testing harness interaction as much as plugin behavior

The stable solution for automated acceptance was:

1. write the same explicit absolute plugin path into a temp config file for operator-facing documentation proof
2. import `/root/_/opencode/opencode-context-compression/src/index.ts` directly in the test
3. initialize the plugin with a temp `directory` / `worktree`
4. call the returned `experimental.chat.messages.transform` hook against temp project messages
5. assert the operator-visible side effects in the temp project, especially the SQLite sidecar under `state/<session-id>.db`

This still verifies the real plugin entry file, real hook wiring, real projection path, and real sidecar behavior, while avoiding a flaky dependency on nested CLI/TTY/runtime interactions.

Keep `npm run probe:seams` as the dedicated manual CLI seam-debug path. Use direct plugin initialization for automated e2e loading proof unless a future task specifically needs to validate the outer `opencode run` process contract itself.

### Applies To
- `tests/e2e/plugin-loading-and-projection.test.ts`
- future plugin-loading acceptance tests in this repo
- seam-debug fixture design when deciding between nested CLI launches and direct hook execution
