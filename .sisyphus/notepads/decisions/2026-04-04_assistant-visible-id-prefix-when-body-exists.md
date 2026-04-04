## assistant-visible-id-prefix-when-body-exists
Date: 2026-04-04
Task: current-session

### Decision
When an assistant turn already has visible body text, the assistant visible id should be prepended directly to that text. Only when a turn emits tool calls with no assistant text at all should projection synthesize an id-only assistant shell. Each tool result still needs its own msg id prepended at the front; array-shaped tool results insert that id as the first text item.

### Rationale
A previous clarification correctly removed verbose `Calling <tool>` text from the synthetic assistant shell, but it still overemphasized the shell itself. The user clarified the tighter contract:
- assistant body exists → prepend id to that existing body
- no assistant body exists → synthesize one id-only shell
- tool results are usually single messages, so the durable rule should simply be “prepend each tool result msg id at the front” rather than over-describing batches

This keeps the rendering rule minimal and easier to implement without adding extra narrative text to assistant shells.

### Alternatives Considered
- Always synthesize a shell before tool calls even when assistant body already exists: rejected because it adds unnecessary extra structure.
- Include explanatory prose such as `Calling <tool>` in the shell: rejected because the user wants only the id.
- Keep long “batch of tools” wording in the main design contract: rejected because the core stable rule is simply prefix existing assistant text when present, otherwise synthesize an id-only shell.

### Consequences
`DESIGN.md` and future implementation should follow:
- existing assistant text gets the assistant visible id prepended at the front
- id-only assistant shell exists only for tool-only turns with no assistant text
- each tool result prepends its own msg id at the front
- array-shaped tool outputs place that id in the first text item
