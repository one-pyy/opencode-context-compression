## assistant-visible-id-prefix-when-body-exists
Date: 2026-04-04
Task: current-session

### Decision
Complete assistant visible-id rendering rule: when assistant body text exists, prepend the id directly to that text; when no assistant body exists (tool-only turn), synthesize an id-only assistant shell. Each tool result prepends its own msg id at the front.

### Rationale
A previous design-doc revision drifted into an over-specified assistant shell example like `Calling <tool>` plus a `toolcall_id` mention. The user clarified the intended contract is much simpler:

**For assistant turns with body text:**
- prepend id to that existing body
- no synthetic shell needed

**For tool-only assistant turns:**
- one assistant shell per contiguous batch of tool calls in the same assistant turn
- shell text should contain only the assistant visible id
- no explanatory prose like `Calling <tool>`

**For tool results (both cases):**
- every tool result needs its own independent msg id
- string outputs: prepend the id at the front
- array-shaped tool results: insert that id as the first text item (front-loaded identifiers are more reliably read by the model)

This keeps the rendering rule minimal and easier to implement without adding extra narrative text to assistant shells. The core stable rule is: prefix existing assistant text when present, otherwise synthesize an id-only shell.

### Alternatives Considered
- Always synthesize a shell before tool calls even when assistant body already exists: rejected because it adds unnecessary extra structure.
- Include explanatory prose such as `Calling <tool>` in the shell: rejected because the user wants only the id.
- Keep long "batch of tools" wording in the main design contract: rejected because the core rule is simpler than that.
- Reuse one id across the whole tool batch without per-tool result ids: rejected because each tool result still needs its own referable msg id.
- Append ids at the end of tool strings or later array positions: rejected because the model reads front-loaded identifiers more reliably.

### Consequences
`DESIGN.md` and future implementation should follow:
- existing assistant text gets the assistant visible id prepended at the front
- id-only assistant shell exists only for tool-only turns with no assistant text
- the synthetic assistant shell is a projection artifact, not a host-history business message
- each tool result has its own visible msg id prepended at the front
- array-shaped tool outputs place that id in the first text item
