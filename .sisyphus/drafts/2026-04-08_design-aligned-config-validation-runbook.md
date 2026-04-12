# Design-Aligned Manual Validation Runbook for Runtime Configuration

Date: 2026-04-08

## 1. Purpose

This document defines a **manual, live-host validation runbook** for the current runtime configuration surface of `opencode-context-compression`.

It is intentionally written to align as tightly as possible with `DESIGN.md`, with one explicit exception:

- For planning input size, token scale may be estimated with a **repo-owned `chars / 4` approximation**.
- That approximation is **not** treated as truth for pass/fail. It is used only to size live inputs.

This runbook is not an automated test plan. It is a **real-host, artifact-driven validation procedure**.

## 2. Non-Negotiable Validation Rules

1. **Do not use repository tests as proof.**
   - This runbook is for live/manual validation only.
   - Existing automated tests may inspire scenario design, but they do not count as business proof.

2. **Use real host artifacts as truth.**
   - Primary evidence sources are:
     - `opencode export <session-id>`
     - repo-owned runtime log JSONL
     - repo-owned seam observation JSONL
     - repo-owned debug snapshots
     - repo-owned SQLite sidecar
     - repo-owned lock files
     - mitmproxy captures when transport/model behavior must be proven

   **Design-fit note:** `opencode export <session-id>` is **canonical host history evidence**.
   It must not be treated as proof of the final prompt-visible projection view.
   Projection evidence must come from projection-specific artifacts (for example, debug snapshots)
   or from other host-visible prompt-view surfaces explicitly defined by the design.

3. **Do not infer tool success from model prose.**
   - For any `compression_mark` scenario, success requires host-visible tool evidence.

4. **Use current projected visible IDs only.**
   - Never target `msg_*` or guessed IDs.
   - Every `compression_mark` call must use visible IDs taken from the current projected host-visible view.

5. **Do not let implementation reality override design.**
   - `DESIGN.md` is the authority.
   - If observed behavior differs from design, record it as drift or non-conformance.

6. **Keep failure localization fast.**
   - Every scenario must write to case-specific log paths.
   - Every session must include a case tag in the first user message.
   - Every scenario must define a primary failure split so that an operator can distinguish:
     - host/plugin loading failure
     - projection failure
     - tool dispatch failure
     - scheduler/gate failure
     - prompt/model transport failure

## 3. Design Anchors

This runbook is derived from the following `DESIGN.md` areas:

- **Section 9 - Configuration Surface**
  - Canonical config file
  - field list
  - env overrides
  - `schedulerMarkThreshold` vs `markedTokenAutoCompactionThreshold`
  - reminder thresholds and prompt-path surface
- **Section 10 - Projection Rules**
  - message classification
  - replacement rendering
  - mark-tool-call removal in projection
- **Section 11 - Prompt File Inventory**
  - compaction prompt as template
  - reminder prompt files as plain text
- **Section 12 - Runtime / Sidecar / Seam Boundaries**
  - plugin-root path resolution
  - sidecar/log/snapshot location rules
  - `experimental.chat.messages.transform` as the only projection seam
  - `chat.params` as scheduler metadata seam only
- **Section 13 - Validation Boundary**
  - what live verification can and cannot claim
- **Section 14 - Design Decisions**
  - `allowDelete` as admission gate
  - reminder token semantics and cadence
  - visible-id structure and single-exit rendering
  - tool-only assistant visibility rule

## 4. What This Runbook Covers

This runbook covers the currently declared runtime configuration points:

- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH`
- `allowDelete`
- `promptPath`
- `compactionModels`
- `schedulerMarkThreshold`
- `markedTokenAutoCompactionThreshold`
- `smallUserMessageThreshold`
- `runtimeLogPath`
- `seamLogPath`
- `logging.level`
- `compressing.timeoutSeconds`
- `reminder.hsoft`
- `reminder.hhard`
- `reminder.softRepeatEveryTokens`
- `reminder.hardRepeatEveryTokens`
- `reminder.promptPaths.compactOnly.soft`
- `reminder.promptPaths.compactOnly.hard`
- `reminder.promptPaths.deleteAllowed.soft`
- `reminder.promptPaths.deleteAllowed.hard`
- `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_MODELS`
- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG`
- `OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL`
- `OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS`
- `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`
- `version`

This runbook does **not** define runtime validation for `$schema`, because `$schema` is an editor/schema integration aid rather than a runtime behavior switch.

## 5. Shared Setup For Every Scenario

### 5.1 Host isolation

Use a sandbox OpenCode config rooted at `XDG_CONFIG_HOME`. Do **not** rely on `OPENCODE_CONFIG_PATH` for real-host isolation.

Before each scenario:

1. Prepare a sandbox config directory.
2. Ensure the sandbox config explicitly loads this plugin.
3. Run:

```bash
XDG_CONFIG_HOME="$OPENCODE_TEST_CONFIG_ROOT" opencode debug config
```

The scenario must not proceed unless:

- `plugin` points at the intended plugin entry
- `plugin_origins` points at the sandbox config root

### 5.2 Fixed live-model rule

For real-host validation, use:

```text
qwen 3.6 free
```

Do not switch models mid-scenario.

**Operator convention notice:** Using a single fixed model for a scenario is an execution convention
to reduce variance. It is not, by itself, a `DESIGN.md` requirement.

### 5.3 Case-specific evidence layout

Each scenario must use a unique case tag, for example `C2A`, `C5D`, `C7B`.

Each scenario should write to:

- `logs/cases/<CASE>/runtime-events.jsonl`
- `logs/cases/<CASE>/seam-observation.jsonl`
- `logs/cases/<CASE>/debug-snapshots/`

The first user message in the session must include the case tag, for example:

```text
[CASE C2A] ...
```

### 5.4 Mandatory evidence bundle per scenario

At the end of each scenario, collect:

1. session id
2. `opencode export <session-id>`
3. case-specific runtime log
4. case-specific seam log
5. case-specific debug snapshots
6. `state/<session-id>.db` if the scenario touches sidecar state
7. lock file, if the scenario concerns compaction gate behavior
8. mitmproxy capture, if the scenario concerns prompt payload or model fallback

## 6. Shared Failure Triage Order

When a scenario fails, diagnose in this order:

1. **Host isolation failure**
   - `opencode debug config` did not use the sandbox config.

2. **Plugin loading / seam activation failure**
   - no seam log
   - no runtime transform events

3. **Projection-only failure**
   - transform events exist, but output snapshot/export does not match projection expectations.

   **Important:** if export (canonical history) and debug snapshots (projection) disagree,
   do not “average” them. Treat export as canonical-history truth and treat snapshots as
   projection truth. Diagnose which layer is drifting.

4. **Tool dispatch formation failure**
   - the model was instructed to call a tool, but host history shows no tool part/call ID and runtime log shows no `tool.execute.before` event.

5. **Scheduler or gate failure**
   - `chat.params` metadata or send-entry gate behavior disagrees with the scenario's expected threshold/lock state.

6. **Transport/prompt/model-chain failure**
   - compaction dispatch happened, but prompt contents, model order, or fallback behavior differ from configuration.

## 7. Scenario Matrix

The scenarios are intentionally merged where design-compatible, but each one still has distinct failure splits.

---

## 8. Scenario C0 - Loading, Path Resolution, and Observability Baseline

### 8.1 Covered configuration points

- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH`
- `runtimeLogPath`
- `seamLogPath`
- `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`
- plugin-root relative path resolution
- `version`
- `OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL` as parse-level smoke only

### 8.2 Goal

Prove that:

1. the plugin loads from the sandbox config,
2. repo-owned artifact paths resolve from plugin root,
3. transform/runtime/seam observability surfaces are active,
4. debug snapshots are emitted only when configured.

### 8.3 Configuration

Prepare `runtime-config.C0.jsonc` with:

- `version: 1`
- `logging.level: "debug"`
- `runtimeLogPath: "logs/cases/C0/runtime-events.jsonl"`
- `seamLogPath: "logs/cases/C0/seam-observation.jsonl"`

Set env:

- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH=<path-to-runtime-config.C0.jsonc>`
- `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH=logs/cases/C0/debug-snapshots`

### 8.4 Procedure

1. Start OpenCode from a directory that is **not** the plugin root.
2. Confirm sandbox config via `opencode debug config`.
3. Run a minimal seam-liveness command if desired.
4. Open a fresh session.
5. Send:

```text
[CASE C0] Reply with BASELINE_OK only. Do not call any tool.
```

6. Collect export, runtime log, seam log, and snapshots.

### 8.5 Success criteria

- sandbox plugin configuration is active
- `logs/cases/C0/...` files exist under plugin root
- runtime evidence shows that `experimental.chat.messages.transform` executed for the session
- seam log exists and records seam activity
- `debug-snapshots/<session>.in.json` and `.out.json` exist
- the output snapshot shows visible-id-prefixed projected text

### 8.6 Failure localization

- wrong `plugin_origins` -> sandbox loading failure, not config-surface failure
- no seam log and no runtime log -> plugin did not load or seam services are dead
- runtime log exists but snapshots do not -> debug snapshot path/config failure
- files appear under the launch working directory rather than plugin root -> repo-root path resolution failure

---

## 9. Scenario C1 - Config File Selection and Field-Level Env Override Precedence

### 9.1 Covered configuration points

- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH`
- `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG`
- `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH`
- absolute-vs-relative override handling

### 9.2 Goal

Prove that:

1. switching config files changes runtime behavior,
2. field-level env overrides take precedence over config-file values,
3. absolute override paths remain absolute.

### 9.3 Configuration set

Prepare:

- `runtime-config.C1A.jsonc` with `allowDelete: false` and case-local log paths
- `runtime-config.C1B.jsonc` with `allowDelete: true` and different case-local log paths

### 9.4 Procedure

#### C1A - config A only

1. Set `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH` to config A.
2. Run a fresh session with a simple non-tool exchange.
3. Record output/log locations and later reuse this configuration in delete-admission validation.

#### C1B - config B only

1. Point `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH` to config B.
2. Run the same simple live exchange.
3. Record output/log locations and later reuse this configuration in delete-admission validation.

#### C1C - file values overridden by env

1. Keep config B active.
2. Override with absolute paths:
   - `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH=/tmp/.../runtime.jsonl`
   - `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG=/tmp/.../seam.jsonl`
   - `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH=/tmp/.../snapshots`
3. Run a fresh session with a simple non-tool exchange.
4. Verify that artifacts land in the absolute override paths.

### 9.5 Success criteria

- changing config A vs B changes the active runtime behavior where later scenarios depend on it
- absolute env overrides determine artifact locations even when config files specify different relative paths

### 9.6 Failure localization

- behavior does not change across A/B -> config-path override failure
- behavior changes but logs do not move -> field-level env override failure
- absolute path gets re-rooted under the plugin directory -> absolute-path handling failure

---

## 10. Scenario C2 - Message Classification, Reminder Thresholds, Cadence, and Reminder Prompt Variant Selection

### 10.1 Covered configuration points

- `smallUserMessageThreshold`
- `reminder.hsoft`
- `reminder.hhard`
- `reminder.softRepeatEveryTokens`
- `reminder.hardRepeatEveryTokens`
- `reminder.promptPaths.compactOnly.soft`
- `reminder.promptPaths.compactOnly.hard`
- `reminder.promptPaths.deleteAllowed.soft`
- `reminder.promptPaths.deleteAllowed.hard`
- `allowDelete` as reminder prompt selector

### 10.2 Goal

Prove, in a design-aligned way, that:

1. short user messages remain `protected`,
2. long user messages become `compressible`,
3. reminder insertion follows token-threshold logic,
4. reminder repetition follows token-based cadence,
5. reminder text selection follows the `severity × allowDelete` matrix.

### 10.3 Configuration

Prepare two configs with deliberately small thresholds to keep manual testing practical.

#### C2A

- `allowDelete: false`
- `smallUserMessageThreshold: 40`
- `reminder.hsoft: 120`
- `reminder.hhard: 240`
- `reminder.softRepeatEveryTokens: 80`
- `reminder.hardRepeatEveryTokens: 80`

#### C2B

Same as C2A, except:

- `allowDelete: true`

Prepare four reminder files with unique sentinel text:

- `[SOFT-COMPACT-C2] ...`
- `[HARD-COMPACT-C2] ...`
- `[SOFT-DELETE-C2] ...`
- `[HARD-DELETE-C2] ...`

### 10.4 Procedure

Run two fresh sessions, one for C2A and one for C2B.

In each session:

1. Send a short user message whose length is safely below `smallUserMessageThreshold`.
2. Send one or more long user messages whose combined size is sufficient to cross the configured reminder thresholds.
3. Keep the assistant in ordinary reply mode. Do not instruct a tool call.
4. After each turn, capture:
   - canonical history via `opencode export <session-id>`
   - projected prompt-visible view via debug snapshots (or another projection-specific artifact)
   - the reminder artifact itself (presence, severity, wording variant, and anchor position)

Use `chars / 4` only to estimate how large the long user messages should be.

### 10.5 Success criteria

- the short user message is rendered with a `protected_*` visible ID
- long user messages are rendered with `compressible_*` visible IDs
- before `hsoft`, no reminder appears
- at or after `hsoft` and before `hhard`, a soft reminder appears
- at or after `hhard`, the active reminder becomes hard rather than soft
- repeated reminders appear only after the configured token step increments
- C2A reminder text matches compact-only prompt files
- C2B reminder text matches delete-allowed prompt files

**Anchor requirement (design-critical):** when a reminder threshold is crossed, the reminder must
be inserted immediately after the **compressible** message that actually crosses the token milestone.
If the milestone falls within a message, the reminder anchors after that message.

### 10.6 Failure localization

- short/long user classification is wrong -> `smallUserMessageThreshold` or classification semantics failure
- threshold crossing behavior is wrong -> `hsoft`/`hhard` failure
- repetition cadence is wrong -> `softRepeatEveryTokens`/`hardRepeatEveryTokens` failure
- correct reminder count but wrong reminder wording -> prompt-path selection failure
- correct wording but wrong visible-state classification -> projection/policy separation failure

---

## 11. Scenario C3 - Delete Admission Gate for `compression_mark`

### 11.1 Covered configuration points

- `allowDelete`

### 11.2 Critical prerequisite

This scenario is valid only if the host actually forms tool calls.

If there is no host-visible evidence that a tool call was formed and executed
(for example, no tool call and tool result recorded in canonical history),
then the result must be classified as **upstream tool-dispatch formation failure**,
not as an `allowDelete` failure.

### 11.3 Goal

Prove that:

- `allowDelete=false` rejects `mode=delete`
- `allowDelete=true` admits `mode=delete`

### 11.4 Procedure

Run two fresh sessions:

- one with `allowDelete=false`
- one with `allowDelete=true`

In each session:

1. First obtain at least two current projected visible IDs from the live session.
2. Issue a precise instruction to call `compression_mark` exactly once using:
   - `contractVersion: v1`
   - `mode: delete`
   - `target.startVisibleMessageID=<current visible id>`
   - `target.endVisibleMessageID=<current visible id>`
3. Collect export, runtime log, seam log, and the next turn's projection evidence.

### 11.5 Success criteria

#### `allowDelete=false`

- host-visible tool evidence exists
- tool result is an error indicating delete is not allowed
- no successful delete mark is established from that call

#### `allowDelete=true`

- host-visible tool evidence exists
- tool result reports success and returns a mark id
- projection/runtime debug indicates accepted `compression_mark` activity

### 11.6 Failure localization

- no tool evidence in either branch -> upstream dispatch-formation failure
- blocked branch succeeds -> delete admission failure
- allowed branch still returns delete-not-allowed -> config loading or admission wiring failure
- tool result succeeds but accepted mark accounting does not change -> replay/debug accounting issue

---

## 12. Scenario C4 - Scheduler Count Threshold vs Marked-Token Threshold

### 12.1 Covered configuration points

- `schedulerMarkThreshold`
- `markedTokenAutoCompactionThreshold`

### 12.2 Goal

Prove that:

1. mark-count gating and marked-token gating are distinct,
2. `chat.params` remains a narrow metadata seam,
3. scheduler metadata reflects the correct reason for non-dispatch or dispatch.

### 12.3 Configuration set

Prepare at least three configurations.

#### C4A

- `schedulerMarkThreshold: 1`
- `markedTokenAutoCompactionThreshold: 1000`

#### C4B

- `schedulerMarkThreshold: 2`
- `markedTokenAutoCompactionThreshold: 1000`

#### C4C

- `schedulerMarkThreshold: 2`
- `markedTokenAutoCompactionThreshold: 100`

### 12.4 Procedure

Each configuration gets its own fresh session.

For each session:

1. Create current visible IDs.
2. Form one or more valid `compression_mark(mode=compact)` calls.
3. Send a follow-up ordinary message so that `chat.params` runs for the current session state.
4. Read scheduler evidence from any design-allowed surfaces available in the environment.
   - `DESIGN.md` permits `chat.params` to emit narrow scheduler metadata under provider options.
   - If the environment exposes that metadata, capture it.
   - If not, do not fabricate a metadata shape. Instead, use indirect but design-aligned signals
     such as lock creation and subsequent waiting behavior.

Use these branches:

- C4A: one mark, but not enough marked-token total
- C4B: one mark, while mark-count threshold requires two
- C4C: two valid marks, with sufficient marked-token total

### 12.5 Success criteria

#### C4A

- one unresolved mark exists (by tool evidence)
- scheduler does not dispatch
- the non-dispatch cause is consistent with “marked-token threshold not yet reached”
  (whether expressed directly in metadata, or indirectly through absence of dispatch/lock)

#### C4B

- scheduler does not dispatch because mark-count gating is stricter than the current mark set
- this must be distinguishable from token-threshold non-dispatch (either via explicit metadata,
  or by constructing paired scenarios that isolate which condition changed)

#### C4C

- scheduler becomes eligible/scheduled under the configured rules
- if the environment exposes a frozen batch snapshot, capture it as supplemental evidence
- otherwise, capture dispatch-adjacent evidence such as lock creation and a shift in waiting behavior

### 12.6 Failure localization

- no `chat.params` event -> scheduler seam not active
- mark never forms -> upstream tool formation or replay issue, not threshold issue
- count threshold and token threshold produce indistinguishable behavior -> threshold separation failure
- metadata rewrites prompt-visible content -> `chat.params` seam boundary violation

---

## 13. Scenario C5 - Compaction Lock Timeout and Send-Entry Gate Release Semantics

### 13.1 Covered configuration points

- `compressing.timeoutSeconds`

### 13.2 Goal

Prove that the send-entry gate behaves according to lock state, and that stale running locks are released by timeout semantics rather than indefinite waiting.

### 13.3 Configuration

Use a config with:

- `compressing.timeoutSeconds: 3`

### 13.4 Lock record format

`DESIGN.md` defines lock behavior at the semantic level (existence, timeout ignoring, manual removal)
but does not define a serialized lock-file schema. Therefore:

- Do not assume a JSON lock schema is part of the design contract.
- Do not assume you can edit fields like `status` to drive gate behavior.

Manual lock scenarios must operate only on what the design actually promises:

- A lock artifact exists in the repo-owned `locks/` area for the session.
- Deleting the lock artifact is a supported manual recovery action.
- A lock older than `compressing.timeoutSeconds` is ignored.

### 13.5 Procedure set

#### C5A - no lock baseline

1. Ensure no lock exists.
2. Send an ordinary message.
3. Confirm gate result reports `no-lock`.

#### C5B - manual clear

1. Create a running lock for the current session.
2. Start a normal send.
3. Before timeout, manually remove the lock file.
4. Confirm gate result reports release by manual clearing.

#### C5C - terminal failure semantics (design-level)

1. Arrange a scenario where background compaction reaches a terminal failure state,
   and the system is expected to stop waiting without relying on timeout.
2. Start a normal send during the lock.
3. Confirm that waiting ends when the terminal failure state is reached.

Note: do not enforce how terminal failure is encoded on disk unless the design defines it.

#### C5D - terminal success semantics (design-level)

1. Arrange a scenario where background compaction completes successfully.
2. Start a normal send during the lock.
3. Confirm that waiting ends when compaction completes and the lock is cleared.

#### C5E - timeout / stale release

1. Create a running lock whose `startedAtMs` is already older than the configured timeout.
2. Start a normal send.
3. Confirm gate result reports timeout rather than indefinite waiting.

### 13.6 Success criteria

- C5A: ordinary send proceeds immediately because no active lock exists
- C5B: ordinary send waits while lock exists, then proceeds after manual lock removal
- C5C: ordinary send waits while lock exists, then proceeds when terminal failure is reached
- C5D: ordinary send waits while lock exists, then proceeds when compaction completes successfully
- C5E: ordinary send does not wait indefinitely on a stale lock; it proceeds once the timeout rule applies

### 13.7 Failure localization

- no waiting when a same-session running lock exists -> lock path/session matching failure
- stale lock never times out -> timeout configuration not wired to send-entry gate
- gate wait/release behavior disagrees with design semantics -> gate/lock semantics failure
- normal send remains blocked forever -> stale-lock or polling failure

---

## 14. Scenario C6 - Prompt Asset Validation and Rejection Semantics

### 14.1 Covered configuration points

- `promptPath`
- `reminder.promptPaths.*`
- `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`

### 14.2 Goal

Prove that prompt assets obey the design contract:

- compaction prompt is a template asset
- reminder prompts are plain-text assets
- missing/empty/placeholder-invalid reminder assets are rejected

### 14.3 Procedure set

#### C6A - missing compaction prompt

1. Point `promptPath` to a non-existent file.
2. Start the plugin.
3. Confirm startup fails with a missing prompt asset error.

#### C6B - missing reminder prompt

1. Point one reminder prompt path to a non-existent file.
2. Start the plugin.
3. Confirm startup fails and identifies the reminder asset.

#### C6C - empty reminder prompt

1. Point a reminder prompt path to an empty/whitespace-only file.
2. Start the plugin.
3. Confirm startup is rejected.

#### C6D - placeholder-bearing reminder prompt

1. Put a template placeholder such as `{{placeholder}}` inside a reminder prompt file.
2. Start the plugin.
3. Confirm startup is rejected because reminder prompts must be plain text.

#### C6E - env override for compaction prompt path

1. Leave config-file `promptPath` valid.
2. Override it with `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH` pointing at another valid prompt file.
3. Defer proof of actual prompt usage to Scenario C7 transport capture.

### 14.4 Success criteria

- invalid prompt assets are rejected at startup/load time
- reminder prompt files are treated as plain text, not variable templates
- compaction prompt path can be replaced via env override

### 14.5 Failure localization

- invalid reminder prompt is accepted -> reminder prompt validation failure
- reminder prompt placeholder is tolerated -> plain-text contract violation
- compaction prompt override is ignored later in transport capture -> env prompt-path override failure

---

## 15. Scenario C7 - Compaction Prompt Provenance and Model Fallback Order

### 15.1 Covered configuration points

- `promptPath`
- `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH`
- `compactionModels`
- `OPENCODE_CONTEXT_COMPRESSION_MODELS`

### 15.2 Critical prerequisite

Run this scenario only after live evidence already shows that:

- valid marks can be formed,
- scheduler can reach dispatch,
- compaction requests really leave the host.

### 15.3 Goal

Prove, as bounded supplemental live evidence, that:

1. the configured compaction prompt text is the prompt actually sent to compaction transport,
2. model fallback order follows the configured array order,
3. the final committed result reflects the model that actually succeeded.

This scenario must not be used to claim full keep/delete end-to-end proof unless `DESIGN.md`
explicitly authorizes that claim.

### 15.4 Configuration

1. Create a compaction prompt file containing a unique sentinel, for example:

```text
PROMPT_SENTINEL_C7
```

2. Configure the model chain with at least two ordered models.
3. Optionally override the model chain with `OPENCODE_CONTEXT_COMPRESSION_MODELS` when checking env precedence.

**Template-semantics requirement (design-critical):** because the compaction prompt is a template,
transport capture should also check that the outbound prompt includes runtime-injected instructions
for delete permission and execution mode.

### 15.5 Procedure

1. Use a live session that reaches compaction eligibility.
2. With mitmproxy active, force the first model request to fail once.
3. Allow the second configured model to proceed.
4. Capture request bodies and committed sidecar state.

### 15.6 Success criteria

- the compaction request body contains the configured sentinel prompt text
- the first request uses the first configured model
- fallback moves to the next configured model in order
- the committed result group records the model that actually succeeded

### 15.7 Failure localization

- no sentinel in outbound request -> active prompt path is not the configured one
- first outbound model is not the configured first model -> model-chain selection failure
- no fallback after first-model failure -> model fallback order failure
- outbound fallback is correct but committed metadata names a different model -> result-group recording failure

---

## 16. Scenario C8 - Honesty Boundary for Config Points With Limited Runtime Semantics

### 16.1 Covered configuration points

- `logging.level`
- `version`
- `$schema` (boundary note only)

### 16.2 Goal

Avoid overstating what has been proven.

### 16.3 `logging.level`

#### What may be validated

- valid values are accepted
- invalid values are rejected during config loading

#### What must not be claimed without additional evidence

- that `logging.level` currently changes runtime artifact verbosity in a proven way

This runbook therefore treats `logging.level` as a **parse/validation-level configuration point** unless future design-approved evidence shows a stronger runtime effect.

### 16.4 `version`

#### What may be validated

- `version: 1` is accepted as the current contract declaration

#### What must not be claimed without additional evidence

- that `version` currently drives any runtime behavior branch

### 16.5 `$schema`

`$schema` is not part of this runtime runbook.

It may matter to editor/schema tooling, but it is not a runtime behavior switch and should not be misreported as one.

---

## 17. Config-to-Scenario Coverage Matrix

| Config point | Primary scenario(s) | Notes |
|---|---|---|
| `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_CONFIG_PATH` | C0, C1 | load path and config switching |
| `allowDelete` | C2, C3 | reminder branch + delete admission |
| `promptPath` | C6, C7 | asset validation + outbound prompt proof |
| `compactionModels` | C7 | outbound model order and fallback |
| `schedulerMarkThreshold` | C4 | mark-count gating |
| `markedTokenAutoCompactionThreshold` | C4 | marked-token gating |
| `smallUserMessageThreshold` | C2 | protected vs compressible user classification |
| `runtimeLogPath` | C0, C1 | artifact location |
| `seamLogPath` | C0, C1 | artifact location |
| `logging.level` | C8 | parse/validation honesty boundary |
| `compressing.timeoutSeconds` | C5 | lock timeout and release semantics |
| `reminder.hsoft` | C2 | soft threshold |
| `reminder.hhard` | C2 | hard threshold |
| `reminder.softRepeatEveryTokens` | C2 | soft cadence |
| `reminder.hardRepeatEveryTokens` | C2 | hard cadence |
| `reminder.promptPaths.compactOnly.soft` | C2, C6 | positive selection + asset validation |
| `reminder.promptPaths.compactOnly.hard` | C2, C6 | positive selection + asset validation |
| `reminder.promptPaths.deleteAllowed.soft` | C2, C6 | positive selection + asset validation |
| `reminder.promptPaths.deleteAllowed.hard` | C2, C6 | positive selection + asset validation |
| `OPENCODE_CONTEXT_COMPRESSION_PROMPT_PATH` | C6, C7 | env precedence for compaction prompt |
| `OPENCODE_CONTEXT_COMPRESSION_MODELS` | C7 | env precedence for model chain |
| `OPENCODE_CONTEXT_COMPRESSION_RUNTIME_LOG_PATH` | C1 | env precedence for runtime log path |
| `OPENCODE_CONTEXT_COMPRESSION_SEAM_LOG` | C1 | env precedence for seam log path |
| `OPENCODE_CONTEXT_COMPRESSION_LOG_LEVEL` | C8 | parse-level only unless stronger evidence is established |
| `OPENCODE_CONTEXT_COMPRESSION_COMPRESSING_TIMEOUT_SECONDS` | C5 | env precedence for timeout behavior |
| `OPENCODE_CONTEXT_COMPRESSION_DEBUG_SNAPSHOT_PATH` | C0, C1 | snapshot location and activation |
| `version` | C0, C8 | contract declaration smoke only |

## 18. Final Reporting Contract

Each executed scenario must end with a short report containing:

1. case id
2. session id
3. active config file path
4. active env overrides used
5. evidence bundle paths
6. pass/fail per covered config point
7. if failed, the **first failing layer**:
   - sandbox load
   - plugin/seam activation
   - projection
   - tool-call formation
   - scheduler/gate
   - transport/model chain
8. an explicit note whenever the result is only a parse-level proof rather than a behavior-level proof

## 19. Explicit Honesty Clause

This runbook is intentionally strict about what can be claimed.

It is acceptable to conclude:

- “the config point is loaded and parsed correctly, but behavior-level proof is not yet established”
- “the scenario is blocked by upstream tool-dispatch formation”
- “the design requires X, but live observation currently shows Y”

It is not acceptable to conclude:

- “the whole feature works” when only config parsing has been proven
- “the plugin rejected/accepted a tool call” when no host-visible tool call was formed
- “the design allows the current artifact” when the artifact shape is merely observed and not justified by `DESIGN.md`

## 20. One Allowed Exception

The only intentional deviation from strict design truth in this runbook is the use of **`chars / 4` token approximation** for planning manual input sizes.

That approximation is allowed only because the user explicitly permitted a `tiktoken` exception.

Even in this runbook, it must never be used as final proof of reminder or scheduler correctness. Final proof must come from live projection/runtime artifacts.
