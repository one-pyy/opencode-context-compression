## final-repo-owned-operator-contract
Date: 2026-04-03
Task: current-session

### Decision
The final operator contract for `opencode-context-compression` is fully repo-owned: operators use only `compression_mark`, read config and prompt ownership from this repo, and treat repo-owned automated tests as the source of full keep and delete proof.

### Rationale
Cutover Tasks 2 through 7 moved the canonical contract into this repository. Leaving operator docs half-attached to older host tools or older runtime assets would blur the ownership boundary that the code and tests now enforce.

Two tradeoffs drove the final wording:

1. The plugin now has a real public mark tool, real repo-owned config and prompt assets, and real scheduler and lock semantics. Operator docs should describe those stable surfaces directly, because they are part of the maintained contract.
2. Real-session verification is still narrower than full automated proof. The repo-owned e2e path proves keep and delete behavior with an injected safe transport fixture, while the current host-exposed legacy tools do not provide a trustworthy end-to-end proof driver for this plugin in a live session. The docs must preserve that boundary so operators do not mistake plugin load evidence for full keep and delete proof.

### Alternatives Considered
- Keep transitional wording about older host tools and older runtime assets: rejected because it leaves two competing contracts in operator-facing docs and encourages false proof claims.
- Treat real-session observation as equivalent to full keep and delete proof today: rejected because the current live path still lacks a repo-owned default production executor and legacy host tools are not valid proof drivers for the final contract.
- Hide the proof boundary and only describe green tests: rejected because future operators would have to rediscover why live-session success claims were intentionally narrower than repo-owned automated coverage.

### Consequences
Canonical operator docs must keep pointing to `src/config/runtime-config.jsonc`, `src/config/runtime-config.schema.json`, `prompts/compaction.md`, repo-owned log and debug paths, `compression_mark`, keep and delete semantics, and lock behavior.

Future work that adds a default production executor or a fully repo-owned real-session execute path must update both the docs and the cutover audit test before broadening live verification claims.

Until then, reports should distinguish between:

- repo-owned automated proof of keep and delete behavior
- real-session evidence that the plugin loaded and repo-owned runtime surfaces are active
