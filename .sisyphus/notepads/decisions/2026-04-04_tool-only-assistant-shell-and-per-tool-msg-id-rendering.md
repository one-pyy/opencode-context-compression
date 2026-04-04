## tool-only-assistant-shell-and-per-tool-msg-id-rendering
Date: 2026-04-04
Task: current-session

### Decision
For tool-only assistant turns, the prompt-visible projection should render exactly one minimal assistant shell before the batch of tool calls, and that shell should contain only the assistant-visible id. Each tool result must carry its own independent msg id at the front; if the tool output is a content array, insert that msg id as the first text item.

### Rationale
A previous design-doc revision drifted into an over-specified assistant shell example like `Calling <tool>` plus a `toolcall_id` mention. The user clarified the intended contract is much simpler:

- one assistant shell per contiguous batch of tool calls in the same assistant turn
- shell text should contain only the assistant visible id
- every tool result still needs its own independent msg id
- array-shaped tool results should prepend the msg id at the start rather than burying it later in the payload

This preserves readability and stable reference behavior without adding extra explanatory text the model does not need.

### Alternatives Considered
- Include `Calling <tool>` prose in the assistant shell: rejected because the user wants the shell to contain only the id.
- Reuse one id across the whole tool batch without per-tool result ids: rejected because each tool result still needs its own referable msg id.
- Append ids at the end of tool strings or later array positions: rejected because the model reads front-loaded identifiers more reliably.

### Consequences
`DESIGN.md` and future implementation should follow these rules:
- the synthetic assistant shell is a projection artifact, not a host-history business message
- a single batch shell may precede multiple tool calls in the same assistant turn
- each tool result has its own visible msg id
- string outputs put the id at the front of the string
- array outputs insert the id as the first text item
