## repo-owned-operator-and-live-verification-workflow
Date: 2026-04-03

### Use When
Use this workflow when a task changes operator-facing docs, live verification guidance, or durable memory for the final repo-owned contract of `opencode-context-compression`.

### Goal
When the workflow is complete, the canonical docs and target-repo notepad all describe the same current contract: repo-owned config and prompt ownership, `compression_mark` as the only public mark tool, truthful keep and delete semantics, correct lock behavior, and an honest boundary between real-session observation and full automated proof.

### Mechanism
This repo has two separate but connected truth layers.

The first layer is the runtime contract itself. That contract lives in repo-owned code and assets such as `src/config/runtime-config.jsonc`, `src/config/runtime-config.schema.json`, `prompts/compaction.md`, the plugin entry at `src/index.ts`, and repo-owned log and state paths.

The second layer is the operator contract. That contract lives in `README.md`, `readme.zh.md`, `docs/live-verification-with-mitmproxy-and-debug-log.zh.md`, and the target-repo notepad entries under `.sisyphus/notepads/`. The operator contract must not outclaim what the runtime layer and automated tests actually prove.

`tests/cutover/docs-and-notepad-contract.test.ts` ties those two layers together. It is the static audit that prevents docs and durable memory from drifting back toward legacy names, legacy paths, or overclaimed live-session proof.

### Responsibilities
- `README.md` — canonical English operator contract for public tool naming, repo-owned config and log ownership, keep and delete semantics, lock behavior, and the verification truth boundary
- `readme.zh.md` — canonical Chinese operator contract with the same boundaries and claims as the English README
- `docs/live-verification-with-mitmproxy-and-debug-log.zh.md` — live-session observation guide that explains what can honestly be confirmed in a real session today and what still belongs to repo-owned automated proof
- `.sisyphus/notepads/decisions/*.md` — durable architectural or contract decisions that explain why the docs use a given truth boundary
- `.sisyphus/notepads/tutorials/*.md` — reusable operator workflow for keeping docs, live verification guidance, and durable memory aligned
- `tests/cutover/docs-and-notepad-contract.test.ts` — static audit that enforces the final repo-owned wording and required target-repo notepad records

### How To Apply Changes
- For public contract wording changes: edit `README.md` and `readme.zh.md` first, because they define the canonical operator-facing contract
- For live verification boundary changes: edit `docs/live-verification-with-mitmproxy-and-debug-log.zh.md`, and state clearly whether the change broadens observable real-session evidence or only clarifies existing limits
- For durable rationale changes: add or update a `decisions/` record when the task changes a lasting ownership rule, proof boundary, or operator contract tradeoff
- For reusable maintenance guidance: add or update a `tutorials/` record when future agents would otherwise have to rediscover which docs, tests, and notepad entries move together
- For any contract change that should stay enforced: update `tests/cutover/docs-and-notepad-contract.test.ts` so the written contract is checked automatically

### Commands
- `npm run typecheck` — run type safety after doc-adjacent test changes in this repo
- `node --import tsx --test tests/cutover/runtime-config-precedence.test.ts` — confirm the repo-owned config, prompt, and log contract still matches the docs
- `node --import tsx --test tests/cutover/legacy-independence.test.ts` — confirm the canonical contract still excludes legacy tool names and legacy ownership references
- `node --import tsx --test tests/cutover/docs-and-notepad-contract.test.ts` — confirm docs and target-repo notepad entries match the final repo-owned contract

### Result
- Canonical docs mention only the repo-owned contract and avoid transitional host-owned guidance
- The live verification guide preserves the truthful limit that current real-session checks show plugin load and repo-owned runtime side effects, while full keep and delete proof still comes from repo-owned automated tests
- The target repo notepad contains both a decision record and a reusable tutorial that future agents can follow without re-reading the whole cutover plan
- The cutover audit test fails if docs or durable memory drift back toward legacy names, legacy paths, or overstated proof claims

### Notes
- Keep the distinction between “public mark tool” and “internal execution path”. `compression_mark` is public. Batch execution and runner transport are still internal runtime behavior.
- Do not broaden live-session success language until a repo-owned default production executor or another fully repo-owned real-session execute path is both implemented and automatically proven.
