## initial-hook-shapes-and-session-transport-boundary
Date: 2026-04-02

### Pattern / Gotcha
The first real plugin run in `/root/_/opencode/opencode-context-compression` confirmed the practical boundary between seam observation and compaction transport selection: `experimental.chat.messages.transform`, `chat.params`, and `tool.execute.before` can be observed cleanly from a no-op plugin, while ordinary `session.prompt` / `prompt_async` remain unsafe as default compaction transports because they go through the normal session prompt loop.

### Detail
The standalone repo now contains a live no-op observation plugin wired at `src/index.ts` that records hook payload shapes to `logs/seam-observation.jsonl`.

The first real run used a temporary `OPENCODE_CONFIG_DIR` with an explicit file-URL plugin entry pointing at:

- `file:///root/_/opencode/opencode-context-compression/src/index.ts`

and ran `opencode run` from the plugin repo directory.

Observed runtime facts from `logs/seam-observation.jsonl`:

1. **Plugin initialization context**
   - `ctx.directory` and `ctx.worktree` both pointed at `/root/_/opencode/opencode-context-compression`
   - `ctx.client.session` exposed one own key, `_client`, but many prototype methods
   - observed `ctx.client.session` prototype methods included:
     - `abort`
     - `children`
     - `command`
     - `create`
     - `delete`
     - `diff`
     - `fork`
     - `get`
     - `init`
     - `list`
     - `message`
     - `messages`
     - `prompt`
     - `promptAsync`
     - `revert`
     - `share`
     - and others recorded in the JSONL log

   This is useful evidence that the plugin context does expose session-oriented SDK methods, but it does **not** prove any of them are safe for compaction transport.

2. **`chat.params` real shape**
   - top-level keys observed:
     - `agent`
     - `message`
     - `model`
     - `provider`
     - `sessionID`
   - the embedded `message` object exposed fields such as:
     - `id`
     - `sessionID`
     - `role`
     - `agent`
     - `model`
     - `time`
   - later turns also showed `summary` on the message shape after tool usage

   This confirms the design rule already discussed: `chat.params` sees the current message and runtime/provider state, but not the full transcript array. It should stay a narrow scheduling/metadata seam, not a prompt-authoring seam.

3. **`experimental.chat.messages.transform` real shape**
   - output shape was `{ messages: [...] }`
   - each message envelope contained:
     - `info`
     - `parts`
   - identity-bearing fields observed in practice included:
     - `info.id`
     - `info.sessionID`
     - `info.parentID` (assistant messages)
     - `parts[*].id`
     - `parts[*].sessionID`
     - `parts[*].messageID`

   This is the strongest early evidence for the canonical message identifier mapping task: the architecture should talk about a conceptual canonical host message identifier, but implementation should map it onto real upstream identity-bearing fields like these instead of assuming a literal `hostMessageId` field exists.

   For the current design, the checksum source should default to the message envelope's `info.id`.

   - `info.id` is the primary canonical message identifier for host-backed visible IDs
   - `parts[*].messageID` is useful as a consistency check / corroborating field
   - compressed referable blocks should inherit the earliest source message's canonical identifier rather than invent a new primary checksum source

4. **`tool.execute.before` real shape**
   - top-level keys observed:
     - `tool`
     - `sessionID`
     - `callID`
   - output shape observed:
     - `args` object containing actual tool arguments
   - in the test run where the model used `read`, the observed `args` fields were:
     - `filePath`
     - `limit`
     - `offset`

   This is enough evidence that `tool.execute.before` is a viable seam for DCP-tool-specific gating or observation, while still leaving non-DCP tools alone.

5. **Ordinary session prompt transport remains unsafe by default**
   - Upstream static evidence still matters here:
     - `packages/opencode/src/server/routes/session.ts` routes ordinary sends into `SessionPrompt.prompt`
     - `packages/opencode/src/session/prompt.ts` contains the normal prompt loop and message updates
   - The transport contract tests in `tests/transport/contract.test.ts` freeze this rule:
     - ordinary `session.prompt` and `session.prompt_async` are not safe default compaction transports
     - they remain investigation targets only if someone later proves a non-polluting path

### Applies To
- `src/seams/noop-observation.ts`
- `src/seams/file-journal.ts`
- `src/index.ts`
- `tests/seams/noop-observation.test.ts`
- `src/transport/contract.ts`
- `tests/transport/contract.test.ts`
- Future work on canonical message identifier mapping, send-entry waiting, DCP-tool gating, and compaction transport selection
